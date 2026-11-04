use rayon::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
    time::Instant,
};
use tile_dominion_simulation::{
    EngineMetrics, EngineRequest, HumanState, NetworkZoneDelta, SimulationEvent, TickRequest,
    TickResponse, TileTargetIndex, UnitKind, choose_wander_direction, schedule_tick,
    zoned_world::{ZoneKey, ZonedWorld},
};

fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut units = ZonedWorld::new(404.0, 404.0, 64.0, 1_024, 384, 3);
    let mut humans = HashMap::<u32, HumanState>::new();
    let mut obstacles = HashSet::<u32>::new();
    let mut map_width = 0_u32;
    let mut map_height = 0_u32;
    let mut tile_owners = Vec::<u32>::new();
    let mut tile_targets = TileTargetIndex::default();
    let mut schedule_cursors = HashMap::<ZoneKey, usize>::new();
    let mut tile_unsupplied_since = Vec::<u64>::new();
    let mut tile_supply_stage = Vec::<u8>::new();
    let mut last_supply_update = 0_u64;
    let mut last_income_update = 0_u64;
    let mut network_previous =
        HashMap::<(i16, i16), HashMap<u32, tile_dominion_simulation::UnitState>>::new();
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
        let Ok(mut request) = rmp_serde::from_slice::<EngineRequest>(&payload) else {
            break;
        };
        let decode_us = decode_started.elapsed().as_micros() as u64;
        if request.protocol_version != 6 {
            break;
        }
        let sync_started = Instant::now();
        if request.return_schedules {
            units.apply_delta(
                std::mem::take(&mut request.unit_upserts),
                std::mem::take(&mut request.unit_removals),
            );
        } else {
            units.apply_authoritative_delta(
                std::mem::take(&mut request.unit_upserts),
                std::mem::take(&mut request.unit_removals),
            );
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
            tile_unsupplied_since.resize(tile_owners.len(), 0);
            tile_supply_stage.resize(tile_owners.len(), 0);
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
            .units()
            .filter(|unit| unit.blocks_movement && map_width > 0)
            .map(|unit| {
                let x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                let y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                y * map_width + x
            })
            .collect::<HashSet<_>>();
        let mut player_events = Vec::<SimulationEvent>::new();
        for human in humans.values_mut() {
            if !human.alive {
                continue;
            }
            let length = (human.input_x * human.input_x + human.input_y * human.input_y)
                .sqrt()
                .max(1.0);
            let speed = request.config.player_speed
                * (1.0 + f32::from(human.speed_upgrade) * request.config.speed_upgrade_bonus);
            let dx = human.input_x / length * speed * request.dt;
            let dy = human.input_y / length * speed * request.dt;
            let candidate_x = (human.x + dx).clamp(0.1, request.config.map_width - 0.1);
            let candidate_y = (human.y + dy).clamp(0.1, request.config.map_height - 0.1);
            let blocked = |x: f32, y: f32| {
                let index = y.floor() as u32 * map_width + x.floor() as u32;
                obstacles.contains(&index) || wall_obstacles.contains(&index)
            };
            if !blocked(candidate_x, human.y) {
                human.x = candidate_x;
            }
            if !blocked(human.x, candidate_y) {
                human.y = candidate_y;
            }
            if map_width == 0 || map_height == 0 {
                continue;
            }
            let tile_index = human.y.floor() as u32 * map_width + human.x.floor() as u32;
            let owner = tile_owners
                .get(tile_index as usize)
                .copied()
                .unwrap_or_default();
            if owner != human.id && !obstacles.contains(&tile_index) {
                if human.capture_tile != Some(tile_index) {
                    human.capture_tile = Some(tile_index);
                    human.capture_since = request.now;
                } else {
                    let duration = (request.config.capture_hold_ms as f32
                        * if owner == 0 {
                            1.0
                        } else {
                            request.config.enemy_capture_multiplier
                        }
                        * request
                            .config
                            .capture_improved_multiplier
                            .powi(i32::from(human.capture_upgrade)))
                        as u64;
                    if request.now.saturating_sub(human.capture_since) >= duration {
                        if let Some(tile_owner) = tile_owners.get_mut(tile_index as usize) {
                            *tile_owner = human.id;
                        }
                        human.capture_tile = None;
                        player_events.push(SimulationEvent {
                            kind: 0,
                            entity_id: human.id,
                            target_id: 0,
                            tile_index,
                            amount: 0.0,
                            owner_id: human.id,
                        });
                    }
                }
            } else {
                human.capture_tile = None;
            }
        }
        let config = request.config.clone();
        let mut scheduler_config = request.config.clone();
        scheduler_config.tick_budget_us = scheduler_config.tick_budget_us.saturating_mul(3) / 4;
        units.refresh_ghosts(request.detection_range);
        let human_snapshot = humans.values().cloned().collect::<Vec<_>>();
        let unit_targets = units
            .units()
            .map(|unit| (unit.id, unit.owner_id, unit.hp, unit.x, unit.y))
            .collect::<Vec<_>>();
        let zone_inputs = units
            .zones()
            .map(|zone| {
                let local_ids = zone
                    .units
                    .iter()
                    .map(|unit| unit.id)
                    .collect::<HashSet<_>>();
                let mut visible = zone.units.clone();
                visible.extend(
                    zone.ghosts
                        .iter()
                        .filter_map(|ghost| units.get(&ghost.id).cloned()),
                );
                // A target already acquired remains visible to its attacker until the
                // scheduler releases the lock, even after crossing a zone halo.
                // Only those explicit cross-zone dependencies are copied here.
                for target_id in zone.units.iter().filter_map(|unit| unit.cached_target_id) {
                    if !visible.iter().any(|unit| unit.id == target_id) {
                        if let Some(target) = units.get(&target_id) {
                            visible.push(target.clone());
                        }
                    }
                }
                (
                    zone.key,
                    local_ids,
                    visible,
                    *schedule_cursors.get(&zone.key).unwrap_or(&0),
                )
            })
            .collect::<Vec<_>>();
        let schedule_started = Instant::now();
        let zone_results = zone_inputs
            .into_par_iter()
            .map(|(key, local_ids, visible, cursor)| {
                let mut tick = TickRequest {
                    protocol_version: request.protocol_version,
                    now: request.now,
                    detection_range: request.detection_range,
                    intermediate_radius: request.intermediate_radius,
                    config: scheduler_config.clone(),
                    units: visible,
                    humans: human_snapshot.clone(),
                    start_index: cursor,
                };
                let mut result = schedule_tick(&mut tick);
                result
                    .schedules
                    .retain(|schedule| local_ids.contains(&schedule.id));
                (key, result)
            })
            .collect::<Vec<_>>();
        let mut response = TickResponse {
            request_id: request.request_id,
            schedules: Vec::new(),
            metrics: None,
            next_cursor: 0,
            events: Vec::new(),
            humans: Vec::new(),
            network_zones: Vec::new(),
        };
        for (key, result) in zone_results {
            schedule_cursors.insert(key, result.next_cursor);
            response.schedules.extend(result.schedules);
        }
        schedule_cursors.retain(|key, _| units.zones().any(|zone| zone.key == *key));
        let schedule_us = schedule_started.elapsed().as_micros() as u64;
        let movement_started = Instant::now();
        let mut events = player_events;
        // Robots and returning defenders query the same territorial index with
        // opposite ownership predicates. Cache both hits and misses per owner
        // and tile bucket so nearby defenders share one indexed lookup.
        let mut defender_return_cache = HashMap::<(u32, u32, u32), Option<(f32, f32)>>::new();
        let produced_by_bastion = units
            .units()
            .filter_map(|unit| unit.source_bastion_id)
            .fold(HashMap::<u32, usize>::new(), |mut counts, source_id| {
                *counts.entry(source_id).or_default() += 1;
                counts
            });
        let mut processed_schedules = 0_usize;
        for schedule in &mut response.schedules {
            if processed_schedules > 0
                && processed_schedules % 32 == 0
                && schedule_started.elapsed().as_micros() >= u128::from(config.tick_budget_us)
            {
                break;
            }
            processed_schedules += 1;
            let target_state = schedule.target_id.as_ref().and_then(|id| {
                units
                    .get(id)
                    .map(|target| (target.x, target.y, target.owner_id, false))
                    .or_else(|| {
                        humans
                            .get(id)
                            .map(|target| (target.x, target.y, target.id, true))
                    })
            });
            let defender_started_allied = units.get(&schedule.id).is_some_and(|unit| {
                if unit.kind != UnitKind::Defender || map_width == 0 || map_height == 0 {
                    return false;
                }
                let x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                let y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                tile_owners.get((y * map_width + x) as usize).copied() == Some(unit.owner_id)
            });
            let defender_pursuing = units
                .get(&schedule.id)
                .is_some_and(|unit| unit.kind == UnitKind::Defender && target_state.is_some());
            let defender_return_target = units.get(&schedule.id).and_then(|unit| {
                if unit.kind != UnitKind::Defender || defender_started_allied || defender_pursuing {
                    return None;
                }
                let cache_key = (
                    unit.owner_id,
                    unit.x.max(0.0) as u32 / 8,
                    unit.y.max(0.0) as u32 / 8,
                );
                if let Some(target) = defender_return_cache.get(&cache_key) {
                    return *target;
                }
                let target =
                    tile_targets.nearest_allied(unit.x, unit.y, unit.owner_id, &tile_owners);
                defender_return_cache.insert(cache_key, target);
                target
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
                    let defender_return_position = if unit.kind == UnitKind::Defender
                        && !defender_started_allied
                        && !defender_pursuing
                    {
                        defender_return_target
                    } else {
                        None
                    };
                    if let Some((target_x, target_y)) = defender_return_position {
                        schedule.target_id = None;
                        unit.cached_target_id = None;
                        let dx = target_x - unit.x;
                        let dy = target_y - unit.y;
                        let distance = (dx * dx + dy * dy).sqrt().max(0.001);
                        unit.dir_x = dx / distance;
                        unit.dir_y = dy / distance;
                        unit.next_think = request.now + 200;
                        directed = true;
                    } else if let Some((target_x, target_y, _, _)) = target_state {
                        let dx = target_x - unit.x;
                        let dy = target_y - unit.y;
                        let distance = (dx * dx + dy * dy).sqrt();
                        let attack_range = match unit.kind {
                            UnitKind::Soldier => config.soldier_range,
                            UnitKind::Attacker => config.attacker_range,
                            UnitKind::Defender => config.defender_range,
                            _ => 0.0,
                        };
                        if distance > attack_range {
                            unit.dir_x = dx / distance;
                            unit.dir_y = dy / distance;
                            unit.next_think = request.now + 200;
                            directed = true;
                        } else {
                            unit.dir_x = 0.0;
                            unit.dir_y = 0.0;
                            unit.next_think = request.now + 200;
                            directed = true;
                        }
                    }
                    if !directed {
                        let destination = match unit.order.as_str() {
                            _ if unit.kind == UnitKind::Defender => None,
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
                        if unit.order == "wander" || unit.kind == UnitKind::Defender {
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
                if unit.kind == UnitKind::Bastion
                    && unit.bastion_type == 5
                    && request.now.saturating_sub(unit.last_attack) >= config.turret_cooldown_ms
                {
                    let mut nearest = None::<(u32, f32)>;
                    for &(target_id, target_owner_id, target_hp, target_x, target_y) in
                        &unit_targets
                    {
                        if target_id == unit.id
                            || target_owner_id == unit.owner_id
                            || target_hp <= 0.0
                        {
                            continue;
                        }
                        let distance =
                            ((target_x - unit.x).powi(2) + (target_y - unit.y).powi(2)).sqrt();
                        if distance <= config.turret_range
                            && nearest.is_none_or(|(_, best)| distance < best)
                        {
                            nearest = Some((target_id, distance));
                        }
                    }
                    for target in &human_snapshot {
                        if target.id == unit.owner_id
                            || !target.alive
                            || request.now < target.invulnerable_until
                        {
                            continue;
                        }
                        let distance =
                            ((target.x - unit.x).powi(2) + (target.y - unit.y).powi(2)).sqrt();
                        if distance <= config.turret_range
                            && nearest.is_none_or(|(_, best)| distance < best)
                        {
                            nearest = Some((target.id, distance));
                        }
                    }
                    if let Some((target_id, _)) = nearest {
                        unit.last_attack = request.now;
                        events.push(SimulationEvent {
                            kind: 1,
                            entity_id: unit.id,
                            target_id,
                            tile_index: 0,
                            amount: config.turret_damage,
                            owner_id: unit.owner_id,
                        });
                    }
                }
                if unit.kind == UnitKind::Bastion
                    && (unit.bastion_type == 1 || unit.bastion_type == 2)
                    && request.now >= unit.next_produce
                {
                    let produced_defenders = produced_by_bastion
                        .get(&unit.id)
                        .copied()
                        .unwrap_or_default();
                    let is_factory = unit.bastion_type == 2;
                    let interval = if is_factory {
                        config.factory_production_ms
                    } else {
                        config.fortress_production_ms
                    };
                    if is_factory || produced_defenders < config.max_defenders {
                        unit.next_produce = request.now + interval;
                        events.push(SimulationEvent {
                            kind: 2,
                            entity_id: unit.id,
                            target_id: 0,
                            tile_index: if is_factory { 0 } else { 1 },
                            amount: interval as f32,
                            owner_id: unit.owner_id,
                        });
                    } else {
                        unit.next_produce = request.now + interval;
                    }
                }
                let mut hold_position_for_capture = false;
                if unit.kind == UnitKind::Robot && map_width > 0 && map_height > 0 {
                    let current_x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                    let current_y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                    let current_index = (current_y * map_width + current_x) as usize;
                    let is_capturing = tile_owners
                        .get(current_index)
                        .is_some_and(|owner| *owner != unit.owner_id);
                    if is_capturing {
                        hold_position_for_capture = true;
                    } else {
                        let candidates = tile_targets.nearest_non_allied_candidates(
                            unit.x,
                            unit.y,
                            unit.owner_id,
                            &tile_owners,
                            3,
                        );
                        let choice = if candidates.is_empty() {
                            None
                        } else {
                            let hash =
                                unit.id.wrapping_mul(16_777_619) ^ (request.now / 1_000) as u32;
                            candidates.get(hash as usize % candidates.len()).copied()
                        };
                        if let Some((target_x, target_y)) = choice {
                            let dx = target_x - unit.x;
                            let dy = target_y - unit.y;
                            let distance = (dx * dx + dy * dy).sqrt();
                            if distance > 0.001 {
                                unit.dir_x = dx / distance;
                                unit.dir_y = dy / distance;
                            }
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
                if !hold_position_for_capture
                    && speed > 0.0
                    && schedule.dt > 0.0
                    && (unit.dir_x.abs() > 0.001 || unit.dir_y.abs() > 0.001)
                {
                    let base = unit.dir_y.atan2(unit.dir_x);
                    let offsets = [
                        0.0,
                        std::f32::consts::FRAC_PI_4,
                        -std::f32::consts::FRAC_PI_4,
                        std::f32::consts::FRAC_PI_2,
                        -std::f32::consts::FRAC_PI_2,
                        std::f32::consts::PI,
                    ];
                    let mut moved = false;
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
                        let candidate_owner = tile_owners
                            .get((tile_y * map_width + tile_x) as usize)
                            .copied();
                        let blocked = map_width > 0
                            && map_height > 0
                            && (obstacles.contains(&(tile_y * map_width + tile_x))
                                || wall_obstacles.contains(&(tile_y * map_width + tile_x))
                                || (unit.kind == UnitKind::Defender
                                    && defender_started_allied
                                    && !defender_pursuing
                                    && candidate_owner != Some(unit.owner_id)));
                        if blocked {
                            continue;
                        }
                        unit.x = nx;
                        unit.y = ny;
                        unit.dir_x = dx;
                        unit.dir_y = dy;
                        moved = true;
                        break;
                    }
                    if !moved {
                        unit.next_think = 0;
                    }
                }
                if unit.kind == UnitKind::Robot && map_width > 0 && map_height > 0 {
                    let tile_x = unit.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                    let tile_y = unit.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                    let tile_index = tile_y * map_width + tile_x;
                    let previous_owner = tile_owners.get(tile_index as usize).copied().unwrap_or(0);
                    if previous_owner != unit.owner_id && !obstacles.contains(&tile_index) {
                        if unit.capture_tile != Some(tile_index) {
                            unit.capture_tile = Some(tile_index);
                            unit.capture_since = request.now;
                        }
                        let multiplier = if previous_owner == 0 {
                            1.0
                        } else {
                            config.enemy_capture_multiplier
                        };
                        let duration = (config.robot_capture_ms as f32 * multiplier) as u64;
                        if request.now.saturating_sub(unit.capture_since) >= duration {
                            if let Some(owner) = tile_owners.get_mut(tile_index as usize) {
                                *owner = unit.owner_id;
                            }
                            unit.capture_tile = None;
                            events.push(SimulationEvent {
                                kind: 0,
                                entity_id: unit.id,
                                target_id: 0,
                                tile_index,
                                amount: 0.0,
                                owner_id: unit.owner_id,
                            });
                        }
                    } else {
                        unit.capture_tile = None;
                    }
                }
                if unit.kind.is_combat() {
                    if let (Some(target_id), Some((target_x, target_y, target_owner, is_human))) =
                        (schedule.target_id, target_state)
                    {
                        let (damage, range, cooldown) = match unit.kind {
                            UnitKind::Soldier => (
                                config.soldier_damage,
                                config.soldier_range,
                                config.soldier_cooldown_ms,
                            ),
                            UnitKind::Attacker => (
                                config.attacker_damage,
                                config.attacker_range,
                                config.attacker_cooldown_ms,
                            ),
                            UnitKind::Defender => (
                                config.defender_damage,
                                config.defender_range,
                                config.defender_cooldown_ms,
                            ),
                            _ => unreachable!(),
                        };
                        let distance =
                            ((target_x - unit.x).powi(2) + (target_y - unit.y).powi(2)).sqrt();
                        let target_vulnerable = !is_human
                            || humans.get(&target_id).is_some_and(|human| {
                                human.alive && request.now >= human.invulnerable_until
                            });
                        if target_owner != unit.owner_id
                            && target_vulnerable
                            && distance <= range
                            && request.now.saturating_sub(unit.last_attack) >= cooldown
                        {
                            unit.last_attack = request.now;
                            events.push(SimulationEvent {
                                kind: 1,
                                entity_id: unit.id,
                                target_id,
                                tile_index: 0,
                                amount: damage,
                                owner_id: unit.owner_id,
                            });
                        }
                    }
                }
                schedule.x = unit.x;
                schedule.y = unit.y;
                schedule.dir_x = unit.dir_x;
                schedule.dir_y = unit.dir_y;
                schedule.next_think = unit.next_think;
                schedule.last_attack = unit.last_attack;
            }
        }
        let mut authoritative_events = Vec::with_capacity(events.len());
        for mut event in events {
            if event.kind != 1 {
                authoritative_events.push(event);
                continue;
            }
            let Some(target) = units.get(&event.target_id) else {
                if let Some(snapshot) = humans.get(&event.target_id).cloned() {
                    if !snapshot.alive || request.now < snapshot.invulnerable_until {
                        continue;
                    }
                    let respawn = tile_targets.nearest_allied(
                        snapshot.x,
                        snapshot.y,
                        snapshot.id,
                        &tile_owners,
                    );
                    let mut killed = false;
                    if let Some(human) = humans.get_mut(&event.target_id) {
                        human.hp -= event.amount;
                        if human.hp <= 0.0 {
                            killed = true;
                            if let Some((x, y)) = respawn {
                                human.x = x;
                                human.y = y;
                                human.hp = human.max_hp;
                                human.invulnerable_until =
                                    request.now + config.respawn_invulnerability_ms;
                            } else {
                                human.hp = 0.0;
                                human.alive = false;
                            }
                        }
                    }
                    if killed {
                        if let Some(attacker) = humans.get_mut(&event.owner_id) {
                            attacker.kills = attacker.kills.saturating_add(1);
                        }
                    }
                }
                continue;
            };
            let tile_owner = if map_width > 0 && map_height > 0 {
                let x = target.x.floor().clamp(0.0, map_width as f32 - 1.0) as u32;
                let y = target.y.floor().clamp(0.0, map_height as f32 - 1.0) as u32;
                tile_owners
                    .get((y * map_width + x) as usize)
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let reduction = if tile_owner == target.owner_id {
                0.5
            } else {
                1.0
            };
            event.amount *= reduction;
            let killed = if let Some(target) = units.get_mut(&event.target_id) {
                target.hp -= event.amount;
                target.hp <= 0.0
            } else {
                false
            };
            if killed {
                units.remove(event.target_id);
                event.kind = 3;
            }
            authoritative_events.push(event);
        }
        let supply_due = request.now.saturating_sub(last_supply_update)
            >= config.supply_update_interval_ms
            && map_width > 0
            && map_height > 0;
        if supply_due {
            last_supply_update = request.now;
            let mut supplied = vec![false; tile_owners.len()];
            let mut sources = humans
                .values()
                .filter(|human| human.alive)
                .map(|human| {
                    (
                        human.id,
                        human.capital_x + 0.5,
                        human.capital_y + 0.5,
                        config.supply_capital_radius,
                    )
                })
                .collect::<Vec<_>>();
            sources.extend(units.units().filter_map(|unit| {
                (unit.kind == UnitKind::Bastion && unit.bastion_type == 3).then_some((
                    unit.owner_id,
                    unit.x,
                    unit.y,
                    config.supply_relay_radius,
                ))
            }));
            for (owner_id, source_x, source_y, radius) in sources {
                let min_x = (source_x - radius).floor().max(0.0) as u32;
                let max_x = (source_x + radius)
                    .floor()
                    .min(map_width.saturating_sub(1) as f32) as u32;
                let min_y = (source_y - radius).floor().max(0.0) as u32;
                let max_y = (source_y + radius)
                    .floor()
                    .min(map_height.saturating_sub(1) as f32) as u32;
                let radius_sq = radius * radius;
                for y in min_y..=max_y {
                    for x in min_x..=max_x {
                        let index = (y * map_width + x) as usize;
                        let dx = x as f32 + 0.5 - source_x;
                        let dy = y as f32 + 0.5 - source_y;
                        if dx * dx + dy * dy <= radius_sq
                            && tile_owners.get(index).copied() == Some(owner_id)
                        {
                            supplied[index] = true;
                        }
                    }
                }
            }
            let mut supplied_counts = HashMap::<u32, u32>::new();
            let mut unsupplied_counts = HashMap::<u32, u32>::new();
            for index in 0..tile_owners.len() {
                let owner_id = tile_owners[index];
                if owner_id == 0 || obstacles.contains(&(index as u32)) {
                    tile_unsupplied_since[index] = 0;
                    tile_supply_stage[index] = 0;
                    continue;
                }
                if supplied[index] {
                    *supplied_counts.entry(owner_id).or_default() += 1;
                    tile_unsupplied_since[index] = 0;
                    if tile_supply_stage[index] != 0 {
                        tile_supply_stage[index] = 0;
                        authoritative_events.push(SimulationEvent {
                            kind: 4,
                            entity_id: 0,
                            target_id: 0,
                            tile_index: index as u32,
                            amount: 0.0,
                            owner_id,
                        });
                    }
                    continue;
                }
                *unsupplied_counts.entry(owner_id).or_default() += 1;
                if tile_unsupplied_since[index] == 0 {
                    tile_unsupplied_since[index] = request.now;
                }
                let elapsed = request.now.saturating_sub(tile_unsupplied_since[index]);
                if elapsed >= config.supply_decay_ms {
                    tile_owners[index] = 0;
                    tile_unsupplied_since[index] = 0;
                    tile_supply_stage[index] = 0;
                    authoritative_events.push(SimulationEvent {
                        kind: 0,
                        entity_id: 0,
                        target_id: 0,
                        tile_index: index as u32,
                        amount: 0.0,
                        owner_id: 0,
                    });
                    continue;
                }
                let stage = (1 + elapsed.saturating_mul(u64::from(config.supply_decay_stages))
                    / config.supply_decay_ms.max(1))
                .min(u64::from(config.supply_decay_stages)) as u8;
                if stage != tile_supply_stage[index] {
                    tile_supply_stage[index] = stage;
                    authoritative_events.push(SimulationEvent {
                        kind: 4,
                        entity_id: 0,
                        target_id: 0,
                        tile_index: index as u32,
                        amount: f32::from(stage),
                        owner_id,
                    });
                }
            }
            if request.now.saturating_sub(last_income_update) >= config.income_interval_ms {
                last_income_update = request.now;
                for human in humans.values_mut().filter(|human| human.alive) {
                    let supplied_count =
                        supplied_counts.get(&human.id).copied().unwrap_or_default();
                    let unsupplied_count = unsupplied_counts
                        .get(&human.id)
                        .copied()
                        .unwrap_or_default();
                    human.money += ((supplied_count as f32
                        + unsupplied_count as f32 * config.unsupplied_income_multiplier)
                        * config.income_per_tile)
                        .floor();
                }
            }
        }
        units.reconcile_transfers();
        response.schedules.truncate(processed_schedules);
        response.events = authoritative_events;
        response.humans = humans.values().cloned().collect();
        for (cell_x, cell_y, full) in request.network_cells.iter().copied() {
            let center_x = (f32::from(cell_x) + 0.5) * 16.0;
            let center_y = (f32::from(cell_y) + 0.5) * 16.0;
            let snapshot = units.network_snapshot(center_x, center_y, 48.0);
            let current = snapshot
                .iter()
                .cloned()
                .map(|unit| (unit.id, unit))
                .collect::<HashMap<_, _>>();
            let previous = network_previous.entry((cell_x, cell_y)).or_default();
            let created: Vec<_> = snapshot
                .iter()
                .filter(|unit| !previous.contains_key(&unit.id))
                .cloned()
                .collect();
            let updated: Vec<_> = snapshot
                .iter()
                .filter(|unit| previous.get(&unit.id).is_some_and(|old| old != *unit))
                .cloned()
                .collect();
            let removed: Vec<_> = previous
                .keys()
                .filter(|id| !current.contains_key(id))
                .copied()
                .collect();
            let kind_code = |kind| match kind {
                UnitKind::Robot => 0u8,
                UnitKind::Soldier => 1,
                UnitKind::Bastion => 2,
                UnitKind::Headquarters => 3,
                UnitKind::Attacker => 4,
                UnitKind::Defender => 5,
            };
            let compact = |unit: &tile_dominion_simulation::UnitState| {
                (
                    unit.id,
                    unit.owner_id,
                    kind_code(unit.kind),
                    (unit.x * 128.0).round().clamp(0.0, 65535.0) as u16,
                    (unit.y * 128.0).round().clamp(0.0, 65535.0) as u16,
                    unit.hp,
                    unit.next_produce,
                    unit.bastion_type,
                    (unit.order_x * 128.0).round().clamp(0.0, 65535.0) as u16,
                    (unit.order_y * 128.0).round().clamp(0.0, 65535.0) as u16,
                )
            };
            let frame_created = if full {
                snapshot.iter().map(compact).collect::<Vec<_>>()
            } else {
                created.iter().map(compact).collect::<Vec<_>>()
            };
            let frame_updated = if full {
                Vec::new()
            } else {
                updated
                    .iter()
                    .map(|unit| {
                        (
                            unit.id,
                            (unit.x * 128.0).round().clamp(0.0, 65535.0) as u16,
                            (unit.y * 128.0).round().clamp(0.0, 65535.0) as u16,
                            unit.hp,
                            unit.next_produce,
                        )
                    })
                    .collect::<Vec<_>>()
            };
            let frame_removed = if full { Vec::new() } else { removed };
            let frame = rmp_serde::to_vec(&(frame_created, frame_updated, frame_removed, full))
                .unwrap_or_default();
            response.network_zones.push(NetworkZoneDelta {
                cell_x,
                cell_y,
                frame,
            });
            *previous = current;
        }
        let movement_us = movement_started.elapsed().as_micros() as u64;
        if !request.return_schedules {
            response.schedules.clear();
        }
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
