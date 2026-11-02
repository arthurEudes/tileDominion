use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
    time::Instant,
};
use tile_dominion_simulation::{
    EngineMetrics, EngineRequest, HumanState, TickRequest, TileTargetIndex, UnitKind, UnitState,
    choose_wander_direction, schedule_tick,
};

fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut units = HashMap::<u32, UnitState>::new();
    let mut humans = HashMap::<u32, HumanState>::new();
    let mut obstacles = HashSet::<u32>::new();
    let mut map_width = 0_u32;
    let mut map_height = 0_u32;
    let mut tile_owners = Vec::<u32>::new();
    let mut tile_targets = TileTargetIndex::default();
    let mut schedule_cursor = 0_usize;
    loop {
        let mut length_bytes = [0_u8; 4];
        if stdin.read_exact(&mut length_bytes).is_err() {
            break;
        }
        let length = u32::from_le_bytes(length_bytes) as usize;
        if length > 64 * 1024 * 1024 {
            break;
        }
        let mut payload = vec![0_u8; length];
        if stdin.read_exact(&mut payload).is_err() {
            break;
        }
        let decode_started = Instant::now();
        let Ok(request) = rmp_serde::from_slice::<EngineRequest>(&payload) else {
            break;
        };
        let decode_us = decode_started.elapsed().as_micros() as u64;
        if request.protocol_version != 2 {
            break;
        }
        let sync_started = Instant::now();
        for id in request.unit_removals {
            units.remove(&id);
        }
        for unit in request.unit_upserts {
            units.insert(unit.id.clone(), unit);
        }
        for id in request.human_removals {
            humans.remove(&id);
        }
        for human in request.human_upserts {
            humans.insert(human.id.clone(), human);
        }
        if let Some(map) = request.map_init {
            map_width = map.width;
            map_height = map.height;
            obstacles = map.obstacles.into_iter().collect();
            tile_owners = map.owners;
            tile_targets.rebuild(map_width, map_height, &obstacles);
        }
        for tile in request.tile_upserts {
            let index = tile.index as usize;
            if index < tile_owners.len() {
                tile_owners[index] = tile.owner_id;
            }
            if tile.obstacle {
                obstacles.insert(tile.index);
            } else {
                obstacles.remove(&tile.index);
            }
            tile_targets.set_obstacle(tile.index, tile.obstacle);
        }
        let sync_us = sync_started.elapsed().as_micros() as u64;
        let wall_obstacles = units
            .values()
            .filter(|unit| unit.blocks_movement && map_width > 0)
            .map(|unit| {
                let x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                let y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                y * map_width + x
            })
            .collect::<HashSet<_>>();
        let config = request.config.clone();
        let mut scheduler_config = request.config.clone();
        scheduler_config.tick_budget_us = scheduler_config.tick_budget_us.saturating_mul(3) / 4;
        let mut tick = TickRequest {
            protocol_version: request.protocol_version,
            now: request.now,
            detection_range: request.detection_range,
            intermediate_radius: request.intermediate_radius,
            config: scheduler_config,
            units: units.values().cloned().collect(),
            humans: humans.values().cloned().collect(),
            start_index: schedule_cursor,
        };
        let schedule_started = Instant::now();
        let mut response = schedule_tick(&mut tick);
        schedule_cursor = response.next_cursor;
        let schedule_us = schedule_started.elapsed().as_micros() as u64;
        let movement_started = Instant::now();
        let mut processed_schedules = 0_usize;
        for schedule in &mut response.schedules {
            if processed_schedules > 0
                && processed_schedules % 32 == 0
                && schedule_started.elapsed().as_micros() >= u128::from(config.tick_budget_us)
            {
                break;
            }
            processed_schedules += 1;
            let target_position = schedule.target_id.as_ref().and_then(|id| {
                units
                    .get(id)
                    .map(|target| (target.x, target.y))
                    .or_else(|| humans.get(id).map(|target| (target.x, target.y)))
            });
            if let Some(unit) = units.get_mut(&schedule.id) {
                unit.last_simulated_at = request.now;
                unit.next_simulation_at = schedule.next_simulation_at;
                unit.cached_target_id = schedule.target_id;
                unit.cached_target_until = if schedule.target_id.is_some() {
                    request.now + config.target_cache_ms
                } else {
                    request.now + config.target_acquisition_interval_ms
                };
                if unit.kind.is_combat() {
                    let mut directed = false;
                    if let Some((target_x, target_y)) = target_position {
                        let dx = target_x - unit.x;
                        let dy = target_y - unit.y;
                        let distance = (dx * dx + dy * dy).sqrt();
                        if distance > 0.001 {
                            unit.dir_x = dx / distance;
                            unit.dir_y = dy / distance;
                            unit.next_think = request.now + 200;
                            directed = true;
                        }
                    }
                    if !directed {
                        if unit.kind == UnitKind::Defender && unit.order == "guard" {
                            let dx = unit.order_x - unit.x;
                            let dy = unit.order_y - unit.y;
                            let distance = (dx * dx + dy * dy).sqrt();
                            if distance > config.defender_guard_radius * 0.82 {
                                unit.dir_x = dx / distance.max(0.001);
                                unit.dir_y = dy / distance.max(0.001);
                                unit.next_think = request.now + 350;
                            } else if request.now >= unit.next_think {
                                let mut hash = 2_166_136_261_u32.wrapping_mul(16_777_619) ^ unit.id;
                                hash ^= request.now as u32;
                                let random = hash as f32 / u32::MAX as f32;
                                let angle = if distance > config.defender_guard_radius * 0.6 {
                                    dy.atan2(dx) + (random - 0.5) * std::f32::consts::PI
                                } else {
                                    random * std::f32::consts::TAU
                                };
                                unit.dir_x = angle.cos();
                                unit.dir_y = angle.sin();
                                unit.next_think = request.now + 900 + u64::from(hash % 1201);
                            }
                            directed = true;
                        }
                    }
                    if !directed {
                        let destination = match unit.order.as_str() {
                            "follow" => humans
                                .get(&unit.owner_id)
                                .map(|owner| (owner.x, owner.y, 2.2, true)),
                            "guard" => Some((unit.order_x, unit.order_y, 4.0, false)),
                            "attack" => Some((unit.order_x, unit.order_y, 2.0, false)),
                            _ => None,
                        };
                        if let Some((target_x, target_y, radius, stop_inside)) = destination {
                            let dx = target_x - unit.x;
                            let dy = target_y - unit.y;
                            let distance = (dx * dx + dy * dy).sqrt();
                            if distance > radius {
                                unit.dir_x = dx / distance;
                                unit.dir_y = dy / distance;
                                unit.next_think = request.now + 200;
                                directed = true;
                            } else if stop_inside {
                                unit.dir_x = 0.0;
                                unit.dir_y = 0.0;
                                unit.next_think = request.now + 200;
                                directed = true;
                            }
                        }
                    }
                    if !directed && request.now >= unit.next_think {
                        let mut hash = 2_166_136_261_u32.wrapping_mul(16_777_619) ^ unit.id;
                        hash ^= request.now as u32;
                        if unit.order == "wander" {
                            (unit.dir_x, unit.dir_y) = choose_wander_direction(
                                &unit.id.to_string(),
                                request.now,
                                unit.x,
                                unit.y,
                                (unit.dir_x, unit.dir_y),
                                unit.owner_id,
                                map_width,
                                map_height,
                                &tile_owners,
                                &obstacles,
                            );
                        } else {
                            let angle = (hash as f32 / u32::MAX as f32) * std::f32::consts::TAU;
                            unit.dir_x = angle.cos();
                            unit.dir_y = angle.sin();
                        }
                        unit.next_think = request.now + 700 + u64::from(hash % 901);
                    }
                }
                if unit.kind == UnitKind::Robot && map_width > 0 && map_height > 0 {
                    let current_x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                    let current_y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                    let current_index = (current_y * map_width + current_x) as usize;
                    let is_capturing = tile_owners
                        .get(current_index)
                        .is_some_and(|owner| *owner != unit.owner_id);
                    if is_capturing {
                        schedule.x = unit.x;
                        schedule.y = unit.y;
                        schedule.dir_x = unit.dir_x;
                        schedule.dir_y = unit.dir_y;
                        continue;
                    }
                    if let Some((target_x, target_y)) =
                        tile_targets.nearest_non_allied(unit.x, unit.y, unit.owner_id, &tile_owners)
                    {
                        let dx = target_x - unit.x;
                        let dy = target_y - unit.y;
                        let distance = (dx * dx + dy * dy).sqrt();
                        if distance > 0.001 {
                            unit.dir_x = dx / distance;
                            unit.dir_y = dy / distance;
                        }
                    }
                }
                let speed = match unit.kind {
                    UnitKind::Robot => config.robot_speed,
                    UnitKind::Soldier | UnitKind::Attacker | UnitKind::Defender => {
                        config.soldier_speed
                    }
                    UnitKind::Bastion | UnitKind::Headquarters => 0.0,
                };
                if speed > 0.0 && schedule.dt > 0.0 {
                    let base = unit.dir_y.atan2(unit.dir_x);
                    let offsets = [
                        0.0,
                        std::f32::consts::FRAC_PI_4,
                        -std::f32::consts::FRAC_PI_4,
                        std::f32::consts::FRAC_PI_2,
                        -std::f32::consts::FRAC_PI_2,
                    ];
                    for offset in offsets {
                        let angle = base + offset;
                        let dx = angle.cos();
                        let dy = angle.sin();
                        let nx =
                            (unit.x + dx * speed * schedule.dt).clamp(0.1, config.map_width - 0.1);
                        let ny =
                            (unit.y + dy * speed * schedule.dt).clamp(0.1, config.map_height - 0.1);
                        let tile_x = nx.floor() as u32;
                        let tile_y = ny.floor() as u32;
                        let blocked = map_width > 0
                            && map_height > 0
                            && (obstacles.contains(&(tile_y * map_width + tile_x))
                                || wall_obstacles.contains(&(tile_y * map_width + tile_x)));
                        if blocked {
                            continue;
                        }
                        unit.x = nx;
                        unit.y = ny;
                        unit.dir_x = dx;
                        unit.dir_y = dy;
                        break;
                    }
                }
                if unit.kind == UnitKind::Defender && unit.order == "guard" {
                    let dx = unit.x - unit.order_x;
                    let dy = unit.y - unit.order_y;
                    let distance = (dx * dx + dy * dy).sqrt();
                    let limit = config.defender_guard_radius * 0.96;
                    if distance > limit {
                        unit.x = unit.order_x + dx / distance * limit;
                        unit.y = unit.order_y + dy / distance * limit;
                        unit.dir_x = -dx / distance;
                        unit.dir_y = -dy / distance;
                        unit.next_think = request.now + 350;
                    }
                }
                schedule.x = unit.x;
                schedule.y = unit.y;
                schedule.dir_x = unit.dir_x;
                schedule.dir_y = unit.dir_y;
                schedule.next_think = unit.next_think;
            }
        }
        response.schedules.truncate(processed_schedules);
        let movement_us = movement_started.elapsed().as_micros() as u64;
        response.metrics = Some(EngineMetrics {
            decode_us,
            sync_us,
            schedule_us,
            movement_us,
        });
        let Ok(encoded) = rmp_serde::to_vec(&response) else {
            break;
        };
        let _ = stdout.write_all(&(encoded.len() as u32).to_le_bytes());
        let _ = stdout.write_all(&encoded);
        let _ = stdout.flush();
    }
}
