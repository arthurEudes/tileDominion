use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

mod serde_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        Vec::<u8>::deserialize(deserializer)
    }
}

pub mod zoned_world;

pub const CHUNK_SIZE: f32 = 16.0;
pub const TILE_BUCKET_SIZE: u32 = 8;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SimulationConfig {
    pub combat_interval_ms: u64,
    pub intermediate_interval_ms: u64,
    pub distant_interval_ms: u64,
    pub map_width: f32,
    pub map_height: f32,
    pub robot_speed: f32,
    pub soldier_speed: f32,
    pub target_candidate_limit: usize,
    pub target_acquisition_interval_ms: u64,
    pub target_cache_ms: u64,
    pub tick_budget_us: u64,
    pub defender_guard_radius: f32,
    pub defender_sortie_margin: f32,
    pub robot_capture_ms: u64,
    pub enemy_capture_multiplier: f32,
    pub soldier_damage: f32,
    pub attacker_damage: f32,
    pub defender_damage: f32,
    pub soldier_range: f32,
    pub attacker_range: f32,
    pub defender_range: f32,
    pub soldier_cooldown_ms: u64,
    pub attacker_cooldown_ms: u64,
    pub defender_cooldown_ms: u64,
    pub fortress_production_ms: u64,
    pub factory_production_ms: u64,
    pub max_defenders: usize,
    pub turret_damage: f32,
    pub turret_range: f32,
    pub turret_cooldown_ms: u64,
    pub player_speed: f32,
    pub speed_upgrade_bonus: f32,
    pub capture_hold_ms: u64,
    pub capture_improved_multiplier: f32,
    pub respawn_invulnerability_ms: u64,
    pub supply_update_interval_ms: u64,
    pub supply_decay_ms: u64,
    pub supply_decay_stages: u8,
    pub supply_anchor_radius: f32,
    pub supply_relay_radius: f32,
    pub income_interval_ms: u64,
    pub base_income: f32,
    pub income_tier_one_limit: f32,
    pub income_tier_one_rate: f32,
    pub income_tier_two_limit: f32,
    pub income_tier_two_rate: f32,
    pub income_final_rate: f32,
    pub unsupplied_income_multiplier: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UnitKind {
    Robot,
    Soldier,
    Attacker,
    Defender,
    Bastion,
}

impl UnitKind {
    pub fn is_combat(self) -> bool {
        matches!(self, Self::Soldier | Self::Attacker | Self::Defender)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct UnitState {
    pub id: u32,
    pub owner_id: u32,
    pub kind: UnitKind,
    pub x: f32,
    pub y: f32,
    pub hp: f32,
    #[serde(default)]
    pub dir_x: f32,
    #[serde(default)]
    pub dir_y: f32,
    #[serde(default = "default_order")]
    pub order: String,
    #[serde(default)]
    pub order_x: f32,
    #[serde(default)]
    pub order_y: f32,
    #[serde(default)]
    pub next_think: u64,
    pub next_simulation_at: u64,
    pub last_simulated_at: u64,
    #[serde(default)]
    pub cached_target_id: Option<u32>,
    #[serde(default)]
    pub cached_target_until: u64,
    #[serde(default)]
    pub blocks_movement: bool,
    #[serde(default)]
    pub last_attack: u64,
    #[serde(default)]
    pub capture_tile: Option<u32>,
    #[serde(default)]
    pub capture_since: u64,
    #[serde(default)]
    pub bastion_type: u8,
    #[serde(default)]
    pub next_produce: u64,
    #[serde(default)]
    pub source_bastion_id: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HumanState {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub alive: bool,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub invulnerable_until: u64,
    #[serde(default)]
    pub hp: f32,
    #[serde(default)]
    pub max_hp: f32,
    #[serde(default)]
    pub money: f32,
    #[serde(default)]
    pub kills: u32,
    #[serde(default)]
    pub input_x: f32,
    #[serde(default)]
    pub input_y: f32,
    #[serde(default)]
    pub capture_tile: Option<u32>,
    #[serde(default)]
    pub capture_since: u64,
    #[serde(default)]
    pub speed_upgrade: u8,
    #[serde(default)]
    pub capture_upgrade: u8,
    #[serde(default)]
    pub supply_anchor_x: f32,
    #[serde(default)]
    pub supply_anchor_y: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TickRequest {
    pub protocol_version: u8,
    pub now: u64,
    pub detection_range: f32,
    pub intermediate_radius: f32,
    pub config: SimulationConfig,
    pub units: Vec<UnitState>,
    pub humans: Vec<HumanState>,
    #[serde(default)]
    pub start_index: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EngineRequest {
    pub protocol_version: u8,
    pub request_id: u32,
    pub now: u64,
    pub dt: f32,
    pub detection_range: f32,
    pub intermediate_radius: f32,
    pub config: SimulationConfig,
    #[serde(default)]
    pub unit_upserts: Vec<UnitState>,
    #[serde(default)]
    pub unit_removals: Vec<u32>,
    #[serde(default)]
    pub human_upserts: Vec<HumanState>,
    #[serde(default)]
    pub human_removals: Vec<u32>,
    #[serde(default)]
    pub map_init: Option<MapInit>,
    #[serde(default)]
    pub tile_upserts: Vec<TileUpdate>,
    #[serde(default)]
    pub network_cells: Vec<(i16, i16, bool)>,
    #[serde(default = "default_true")]
    pub return_schedules: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MapInit {
    pub width: u32,
    pub height: u32,
    pub obstacles: Vec<u32>,
    pub owners: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TileUpdate {
    pub index: u32,
    pub owner_id: u32,
    pub obstacle: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UnitSchedule {
    pub id: u32,
    pub dt: f32,
    pub interval_ms: u64,
    pub target_id: Option<u32>,
    pub next_simulation_at: u64,
    pub x: f32,
    pub y: f32,
    pub dir_x: f32,
    pub dir_y: f32,
    pub next_think: u64,
    pub last_attack: u64,
}

fn default_order() -> String {
    "wander".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EngineMetrics {
    pub decode_us: u64,
    pub sync_us: u64,
    pub schedule_us: u64,
    pub movement_us: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SimulationEvent {
    pub kind: u8,
    pub entity_id: u32,
    pub target_id: u32,
    pub tile_index: u32,
    pub amount: f32,
    pub owner_id: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TickResponse {
    pub request_id: u32,
    pub schedules: Vec<UnitSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<EngineMetrics>,
    #[serde(default)]
    pub next_cursor: usize,
    #[serde(default)]
    pub events: Vec<SimulationEvent>,
    #[serde(default)]
    pub humans: Vec<HumanState>,
    #[serde(default)]
    pub network_zones: Vec<NetworkZoneDelta>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NetworkZoneDelta {
    pub cell_x: i16,
    pub cell_y: i16,
    #[serde(with = "serde_bytes")]
    pub frame: Vec<u8>,
}

#[derive(Default)]
pub struct SpatialIndex {
    buckets: HashMap<(i32, i32), Vec<usize>>,
}

impl SpatialIndex {
    pub fn rebuild(&mut self, units: &[UnitState]) {
        self.buckets.clear();
        for (index, unit) in units.iter().enumerate() {
            let key = (
                (unit.x / CHUNK_SIZE).floor() as i32,
                (unit.y / CHUNK_SIZE).floor() as i32,
            );
            self.buckets.entry(key).or_default().push(index);
        }
    }
    pub fn query(&self, x: f32, y: f32, radius: f32) -> impl Iterator<Item = usize> + '_ {
        let min_x = ((x - radius) / CHUNK_SIZE).floor() as i32;
        let max_x = ((x + radius) / CHUNK_SIZE).floor() as i32;
        let min_y = ((y - radius) / CHUNK_SIZE).floor() as i32;
        let max_y = ((y + radius) / CHUNK_SIZE).floor() as i32;
        (min_y..=max_y).flat_map(move |cy| {
            (min_x..=max_x)
                .flat_map(move |cx| self.buckets.get(&(cx, cy)).into_iter().flatten().copied())
        })
    }

    pub fn query_limited(
        &self,
        x: f32,
        y: f32,
        radius: f32,
        seed: u64,
        limit: usize,
    ) -> Vec<usize> {
        if limit == 0 {
            return Vec::new();
        }
        let min_x = ((x - radius) / CHUNK_SIZE).floor() as i32;
        let max_x = ((x + radius) / CHUNK_SIZE).floor() as i32;
        let min_y = ((y - radius) / CHUNK_SIZE).floor() as i32;
        let max_y = ((y + radius) / CHUNK_SIZE).floor() as i32;
        let buckets: Vec<&Vec<usize>> = (min_y..=max_y)
            .flat_map(|cy| (min_x..=max_x).filter_map(move |cx| self.buckets.get(&(cx, cy))))
            .filter(|bucket| !bucket.is_empty())
            .collect();
        let mut candidates = Vec::with_capacity(limit.min(buckets.len() * limit));
        let mut round = 0_usize;
        while candidates.len() < limit {
            let mut added = false;
            for (bucket_index, bucket) in buckets.iter().enumerate() {
                if candidates.len() >= limit {
                    break;
                }
                if round >= bucket.len() {
                    continue;
                }
                let mixed =
                    seed.wrapping_add((bucket_index as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
                let start = (mixed as usize) % bucket.len();
                candidates.push(bucket[(start + round) % bucket.len()]);
                added = true;
            }
            if !added {
                break;
            }
            round += 1;
        }
        candidates
    }
}

#[derive(Default)]
pub struct TileTargetIndex {
    width: u32,
    height: u32,
    buckets: HashMap<(u32, u32), Vec<u32>>,
}

pub fn choose_wander_direction(
    entity_id: &str,
    now: u64,
    x: f32,
    y: f32,
    current_dir: (f32, f32),
    owner_id: u32,
    width: u32,
    height: u32,
    owners: &[u32],
    obstacles: &std::collections::HashSet<u32>,
) -> (f32, f32) {
    let mut base_hash = 2_166_136_261_u32;
    for byte in entity_id.bytes() {
        base_hash = base_hash.wrapping_mul(16_777_619) ^ u32::from(byte);
    }
    base_hash ^= now as u32;
    let adventure = base_hash % 5 == 0;
    let current_x = x.floor().clamp(0.0, width.saturating_sub(1) as f32) as u32;
    let current_y = y.floor().clamp(0.0, height.saturating_sub(1) as f32) as u32;
    let current_allied = width > 0
        && owners
            .get((current_y * width + current_x) as usize)
            .copied()
            == Some(owner_id);
    let mut best = (current_dir.0, current_dir.1, f32::NEG_INFINITY);

    for direction_index in 0..8_u32 {
        let angle = direction_index as f32 * std::f32::consts::FRAC_PI_4;
        let dir_x = angle.cos();
        let dir_y = angle.sin();
        let sample_x = (x + dir_x * 4.0).floor() as i32;
        let sample_y = (y + dir_y * 4.0).floor() as i32;
        let mut allied = 0_u32;
        let mut valid = 0_u32;
        for offset_y in -1..=1 {
            for offset_x in -1..=1 {
                let tile_x = sample_x + offset_x;
                let tile_y = sample_y + offset_y;
                if tile_x < 0 || tile_y < 0 || tile_x >= width as i32 || tile_y >= height as i32 {
                    continue;
                }
                valid += 1;
                let index = tile_y as u32 * width + tile_x as u32;
                if owners.get(index as usize).copied() == Some(owner_id) {
                    allied += 1;
                }
            }
        }
        let allied_ratio = allied as f32 / valid.max(1) as f32;
        let frontier = if allied > 0 && allied < valid {
            1.0 - (2.0 * allied as f32 - valid as f32).abs() / valid as f32
        } else {
            0.0
        };
        let inertia = ((dir_x * current_dir.0 + dir_y * current_dir.1) + 1.0) * 0.5;
        let noise_hash = base_hash
            .wrapping_add(direction_index.wrapping_mul(2_654_435_761))
            .rotate_left(direction_index + 3);
        let noise = noise_hash as f32 / u32::MAX as f32;
        let candidate_x = (x + dir_x).floor() as i32;
        let candidate_y = (y + dir_y).floor() as i32;
        let blocked = candidate_x < 0
            || candidate_y < 0
            || candidate_x >= width as i32
            || candidate_y >= height as i32
            || obstacles.contains(&(candidate_y as u32 * width + candidate_x as u32));
        let allied_weight = if adventure {
            0.0
        } else if current_allied {
            0.03
        } else {
            0.15
        };
        let score = noise * if adventure { 0.75 } else { 0.45 }
            + inertia * 0.25
            + frontier * if adventure { 0.0 } else { 0.35 }
            + allied_ratio * allied_weight
            - if blocked { 2.0 } else { 0.0 };
        if score > best.2 {
            best = (dir_x, dir_y, score);
        }
    }
    (best.0, best.1)
}

impl TileTargetIndex {
    pub fn rebuild(&mut self, width: u32, height: u32, obstacles: &std::collections::HashSet<u32>) {
        self.width = width;
        self.height = height;
        self.buckets.clear();
        for index in 0..width.saturating_mul(height) {
            if !obstacles.contains(&index) {
                self.insert(index);
            }
        }
    }

    pub fn set_obstacle(&mut self, index: u32, obstacle: bool) {
        if self.width == 0 || index >= self.width.saturating_mul(self.height) {
            return;
        }
        let key = self.bucket_key(index);
        if obstacle {
            if let Some(bucket) = self.buckets.get_mut(&key) {
                bucket.retain(|candidate| *candidate != index);
            }
        } else {
            let bucket = self.buckets.entry(key).or_default();
            if !bucket.contains(&index) {
                bucket.push(index);
            }
        }
    }

    pub fn nearest_non_allied(
        &self,
        x: f32,
        y: f32,
        owner_id: u32,
        owners: &[u32],
    ) -> Option<(f32, f32)> {
        self.nearest_candidates(x, y, owner_id, owners, false, 1)
            .into_iter()
            .next()
    }

    pub fn nearest_non_allied_candidates(
        &self,
        x: f32,
        y: f32,
        owner_id: u32,
        owners: &[u32],
        limit: usize,
    ) -> Vec<(f32, f32)> {
        self.nearest_candidates(x, y, owner_id, owners, false, limit)
    }

    pub fn nearest_allied(
        &self,
        x: f32,
        y: f32,
        owner_id: u32,
        owners: &[u32],
    ) -> Option<(f32, f32)> {
        self.nearest_candidates(x, y, owner_id, owners, true, 1)
            .into_iter()
            .next()
    }

    fn nearest_candidates(
        &self,
        x: f32,
        y: f32,
        owner_id: u32,
        owners: &[u32],
        allied: bool,
        limit: usize,
    ) -> Vec<(f32, f32)> {
        if self.width == 0 || self.height == 0 {
            return Vec::new();
        }
        let center_x = (x.max(0.0) as u32 / TILE_BUCKET_SIZE) as i32;
        let center_y = (y.max(0.0) as u32 / TILE_BUCKET_SIZE) as i32;
        let bucket_columns = self.width.div_ceil(TILE_BUCKET_SIZE) as i32;
        let bucket_rows = self.height.div_ceil(TILE_BUCKET_SIZE) as i32;
        let max_ring = bucket_columns.max(bucket_rows);
        let limit = limit.max(1);
        let mut best = Vec::<(f32, f32, f32)>::with_capacity(limit);

        for ring in 0..=max_ring {
            for bucket_y in center_y - ring..=center_y + ring {
                for bucket_x in center_x - ring..=center_x + ring {
                    if bucket_x < 0
                        || bucket_y < 0
                        || bucket_x >= bucket_columns
                        || bucket_y >= bucket_rows
                        || (ring > 0
                            && bucket_x != center_x - ring
                            && bucket_x != center_x + ring
                            && bucket_y != center_y - ring
                            && bucket_y != center_y + ring)
                    {
                        continue;
                    }
                    for index in self
                        .buckets
                        .get(&(bucket_x as u32, bucket_y as u32))
                        .into_iter()
                        .flatten()
                    {
                        let is_allied = owners.get(*index as usize).copied() == Some(owner_id);
                        if is_allied != allied {
                            continue;
                        }
                        let tile_x = (*index % self.width) as f32 + 0.5;
                        let tile_y = (*index / self.width) as f32 + 0.5;
                        let dx = tile_x - x;
                        let dy = tile_y - y;
                        let distance_sq = dx * dx + dy * dy;
                        best.push((tile_x, tile_y, distance_sq));
                        best.sort_unstable_by(|a, b| a.2.total_cmp(&b.2));
                        best.truncate(limit);
                    }
                }
            }
            if best.len() == limit {
                let best_distance_sq = best.last().map(|candidate| candidate.2).unwrap_or_default();
                let min_x = ((center_x - ring).max(0) as u32 * TILE_BUCKET_SIZE) as f32;
                let min_y = ((center_y - ring).max(0) as u32 * TILE_BUCKET_SIZE) as f32;
                let max_x = (((center_x + ring + 1).min(bucket_columns) as u32 * TILE_BUCKET_SIZE)
                    .min(self.width)) as f32;
                let max_y = (((center_y + ring + 1).min(bucket_rows) as u32 * TILE_BUCKET_SIZE)
                    .min(self.height)) as f32;
                let mut nearest_unvisited = f32::INFINITY;
                if min_x > 0.0 {
                    nearest_unvisited = nearest_unvisited.min(x - min_x);
                }
                if max_x < self.width as f32 {
                    nearest_unvisited = nearest_unvisited.min(max_x - x);
                }
                if min_y > 0.0 {
                    nearest_unvisited = nearest_unvisited.min(y - min_y);
                }
                if max_y < self.height as f32 {
                    nearest_unvisited = nearest_unvisited.min(max_y - y);
                }
                if nearest_unvisited.is_infinite()
                    || best_distance_sq <= nearest_unvisited.max(0.0).powi(2)
                {
                    break;
                }
            }
        }
        best.into_iter()
            .map(|(tile_x, tile_y, _)| (tile_x, tile_y))
            .collect()
    }

    fn insert(&mut self, index: u32) {
        let key = self.bucket_key(index);
        self.buckets.entry(key).or_default().push(index);
    }

    fn bucket_key(&self, index: u32) -> (u32, u32) {
        let x = index % self.width;
        let y = index / self.width;
        (x / TILE_BUCKET_SIZE, y / TILE_BUCKET_SIZE)
    }
}

fn distance_sq(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

pub fn schedule_tick(request: &mut TickRequest) -> TickResponse {
    let started = Instant::now();
    let mut spatial = SpatialIndex::default();
    spatial.rebuild(&request.units);
    let mut schedules = Vec::new();
    let unit_indices: HashMap<u32, usize> = request
        .units
        .iter()
        .enumerate()
        .map(|(index, unit)| (unit.id, index))
        .collect();
    let unit_count = request.units.len();
    let start_index = request.start_index.min(unit_count.saturating_sub(1));
    let mut visited = 0_usize;
    while visited < unit_count {
        if visited > 0
            && visited % 32 == 0
            && started.elapsed().as_micros() >= u128::from(request.config.tick_budget_us)
        {
            break;
        }
        let index = (start_index + visited) % unit_count;
        visited += 1;
        if request.now < request.units[index].next_simulation_at {
            continue;
        }
        let unit = &request.units[index];
        let mut nearby_enemies = Vec::new();
        let mut nearby_humans = Vec::new();
        let max_sq = request.detection_range * request.detection_range;
        let target_in_role_area = |target_x: f32, target_y: f32| match unit.kind {
            UnitKind::Attacker => true,
            UnitKind::Soldier | UnitKind::Defender => {
                distance_sq(unit.x, unit.y, target_x, target_y) <= max_sq * 1.25_f32.powi(2)
            }
            _ => false,
        };
        let cached_target_is_valid = unit.cached_target_id.is_some_and(|target_id| {
            unit_indices.get(&target_id).is_some_and(|target_index| {
                let target = &request.units[*target_index];
                target.id != unit.id
                    && target.owner_id != unit.owner_id
                    && target_in_role_area(target.x, target.y)
            }) || request.humans.iter().any(|human| {
                human.id == target_id
                    && human.id != unit.owner_id
                    && human.alive
                    && request.now >= human.invulnerable_until
                    && target_in_role_area(human.x, human.y)
            })
        });
        let acquisition_slots = request
            .config
            .target_acquisition_interval_ms
            .div_ceil(request.config.combat_interval_ms.max(1))
            .max(1);
        let acquisition_due = unit.cached_target_until == 0
            || (request.now / request.config.combat_interval_ms.max(1)) % acquisition_slots
                == u64::from(unit.id) % acquisition_slots;
        if unit.kind.is_combat() && !cached_target_is_valid && acquisition_due {
            let acquisition_slot = request.now / request.config.combat_interval_ms.max(1);
            let seed = u64::from(unit.id)
                .wrapping_mul(0x9e37_79b9)
                .wrapping_add(acquisition_slot);
            nearby_enemies.extend(
                spatial
                    .query_limited(
                        unit.x,
                        unit.y,
                        request.detection_range,
                        seed,
                        request.config.target_candidate_limit,
                    )
                    .into_iter()
                    .filter(|other_index| {
                        let other = &request.units[*other_index];
                        other.id != unit.id
                            && other.owner_id != unit.owner_id
                            && distance_sq(unit.x, unit.y, other.x, other.y) <= max_sq
                    }),
            );
            nearby_humans.extend(request.humans.iter().enumerate().filter_map(
                |(human_index, human)| {
                    (human.id != unit.owner_id
                        && human.alive
                        && distance_sq(unit.x, unit.y, human.x, human.y) <= max_sq)
                        .then_some(human_index)
                },
            ));
        }
        let current_acquisition_slot =
            (request.now / request.config.combat_interval_ms.max(1)) % acquisition_slots;
        let unit_acquisition_slot = u64::from(unit.id) % acquisition_slots;
        let acquisition_delay = (unit_acquisition_slot + acquisition_slots
            - current_acquisition_slot)
            % acquisition_slots
            * request.config.combat_interval_ms.max(1);
        let interval_ms = if unit.kind.is_combat() && !cached_target_is_valid && !acquisition_due {
            acquisition_delay.max(request.config.combat_interval_ms)
        } else if cached_target_is_valid || !nearby_enemies.is_empty() || !nearby_humans.is_empty()
        {
            request.config.combat_interval_ms
        } else if request.humans.iter().any(|p| {
            !p.is_bot
                && p.alive
                && distance_sq(unit.x, unit.y, p.x, p.y)
                    <= request.intermediate_radius * request.intermediate_radius
        }) {
            request.config.intermediate_interval_ms
        } else {
            request.config.distant_interval_ms
        };
        let cached = if cached_target_is_valid {
            unit.cached_target_id
        } else if acquisition_due {
            nearby_enemies
                .into_iter()
                .min_by(|a, b| {
                    let aa = &request.units[*a];
                    let bb = &request.units[*b];
                    if unit.kind == UnitKind::Attacker {
                        return distance_sq(unit.x, unit.y, aa.x, aa.y)
                            .total_cmp(&distance_sq(unit.x, unit.y, bb.x, bb.y));
                    }
                    let a_priority = if aa.kind == UnitKind::Robot { 0 } else { 1 };
                    let b_priority = if bb.kind == UnitKind::Robot { 0 } else { 1 };
                    a_priority.cmp(&b_priority).then_with(|| {
                        distance_sq(unit.x, unit.y, aa.x, aa.y)
                            .total_cmp(&distance_sq(unit.x, unit.y, bb.x, bb.y))
                    })
                })
                .map(|i| request.units[i].id)
                .or_else(|| {
                    nearby_humans
                        .into_iter()
                        .filter(|i| request.now >= request.humans[*i].invulnerable_until)
                        .min_by(|a, b| {
                            let aa = &request.humans[*a];
                            let bb = &request.humans[*b];
                            distance_sq(unit.x, unit.y, aa.x, aa.y)
                                .total_cmp(&distance_sq(unit.x, unit.y, bb.x, bb.y))
                        })
                        .map(|i| request.humans[i].id)
                })
        } else {
            None
        };
        let elapsed =
            ((request.now.saturating_sub(unit.last_simulated_at)) as f32 / 1000.0).clamp(0.0, 0.6);
        schedules.push(UnitSchedule {
            id: unit.id,
            dt: elapsed,
            interval_ms,
            target_id: cached,
            next_simulation_at: request.now + interval_ms,
            x: unit.x,
            y: unit.y,
            dir_x: unit.dir_x,
            dir_y: unit.dir_y,
            next_think: unit.next_think,
            last_attack: unit.last_attack,
        });
    }
    TickResponse {
        request_id: 0,
        schedules,
        metrics: None,
        next_cursor: if unit_count == 0 {
            0
        } else {
            (start_index + visited) % unit_count
        },
        events: Vec::new(),
        humans: Vec::new(),
        network_zones: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unit(id: u32, owner: u32, kind: UnitKind, x: f32) -> UnitState {
        UnitState {
            id,
            owner_id: owner,
            kind,
            x,
            y: 10.0,
            hp: 100.0,
            dir_x: 1.0,
            dir_y: 0.0,
            order: "wander".into(),
            order_x: x,
            order_y: 10.0,
            next_think: 0,
            next_simulation_at: 0,
            last_simulated_at: 0,
            cached_target_id: None,
            cached_target_until: 0,
            blocks_movement: false,
            last_attack: 0,
            capture_tile: None,
            capture_since: 0,
            bastion_type: 0,
            next_produce: 0,
            source_bastion_id: None,
        }
    }
    fn human(id: u32, x: f32, invulnerable_until: u64) -> HumanState {
        HumanState {
            id,
            x,
            y: 10.0,
            alive: true,
            is_bot: false,
            invulnerable_until,
            hp: 100.0,
            max_hp: 100.0,
            money: 0.0,
            kills: 0,
            input_x: 0.0,
            input_y: 0.0,
            capture_tile: None,
            capture_since: 0,
            speed_upgrade: 0,
            capture_upgrade: 0,
            supply_anchor_x: x,
            supply_anchor_y: 10.0,
        }
    }
    fn config() -> SimulationConfig {
        SimulationConfig {
            combat_interval_ms: 50,
            intermediate_interval_ms: 200,
            distant_interval_ms: 500,
            map_width: 202.0,
            map_height: 202.0,
            robot_speed: 2.2,
            soldier_speed: 2.4,
            target_candidate_limit: 12,
            target_acquisition_interval_ms: 200,
            target_cache_ms: 2000,
            tick_budget_us: 35_000,
            defender_guard_radius: 12.0,
            defender_sortie_margin: 7.0,
            robot_capture_ms: 1100,
            enemy_capture_multiplier: 3.0,
            soldier_damage: 12.0,
            attacker_damage: 12.0,
            defender_damage: 18.0,
            soldier_range: 3.2,
            attacker_range: 3.2,
            defender_range: 3.2,
            soldier_cooldown_ms: 800,
            attacker_cooldown_ms: 800,
            defender_cooldown_ms: 800,
            fortress_production_ms: 9000,
            factory_production_ms: 6500,
            max_defenders: 8,
            turret_damage: 16.0,
            turret_range: 8.0,
            turret_cooldown_ms: 900,
            player_speed: 5.2,
            speed_upgrade_bonus: 0.08,
            capture_hold_ms: 550,
            capture_improved_multiplier: 0.88,
            respawn_invulnerability_ms: 2500,
            supply_update_interval_ms: 1000,
            supply_decay_ms: 45_000,
            supply_decay_stages: 9,
            supply_anchor_radius: 24.0,
            supply_relay_radius: 12.0,
            income_interval_ms: 1000,
            base_income: 5.0,
            income_tier_one_limit: 100.0,
            income_tier_one_rate: 0.12,
            income_tier_two_limit: 300.0,
            income_tier_two_rate: 0.07,
            income_final_rate: 0.03,
            unsupplied_income_multiplier: 0.5,
        }
    }
    #[test]
    fn combat_runs_at_twenty_hz() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![
                unit(1, 10, UnitKind::Soldier, 10.0),
                unit(2, 20, UnitKind::Robot, 11.0),
            ],
            humans: vec![],
            start_index: 0,
        };
        let out = schedule_tick(&mut r);
        assert_eq!(out.schedules[0].interval_ms, 50);
        assert_eq!(out.schedules[0].target_id, Some(2));
    }
    #[test]
    fn distant_runs_at_two_hz() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![unit(1, 10, UnitKind::Robot, 10.0)],
            humans: vec![],
            start_index: 0,
        };
        assert_eq!(schedule_tick(&mut r).schedules[0].interval_ms, 500);
    }
    #[test]
    fn intermediate_runs_at_five_hz() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![unit(1, 10, UnitKind::Robot, 10.0)],
            humans: vec![human(10, 11.0, 0)],
            start_index: 0,
        };
        assert_eq!(schedule_tick(&mut r).schedules[0].interval_ms, 200);
    }
    #[test]
    fn enemy_human_triggers_combat_and_is_targeted() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![unit(1, 10, UnitKind::Soldier, 10.0)],
            humans: vec![human(20, 11.0, 0)],
            start_index: 0,
        };
        let response = schedule_tick(&mut r);
        let schedule = &response.schedules[0];
        assert_eq!(schedule.interval_ms, 50);
        assert_eq!(schedule.target_id, Some(20));
    }
    #[test]
    fn invulnerable_human_triggers_combat_without_becoming_a_target() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![unit(1, 10, UnitKind::Soldier, 10.0)],
            humans: vec![human(20, 11.0, 2000)],
            start_index: 0,
        };
        let response = schedule_tick(&mut r);
        let schedule = &response.schedules[0];
        assert_eq!(schedule.interval_ms, 50);
        assert_eq!(schedule.target_id, None);
    }

    #[test]
    fn soldier_does_not_acquire_an_enemy_outside_detection_range() {
        let mut r = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![
                unit(1, 10, UnitKind::Soldier, 10.0),
                unit(2, 20, UnitKind::Robot, 30.0),
            ],
            humans: vec![],
            start_index: 0,
        };
        let response = schedule_tick(&mut r);
        assert_eq!(response.schedules[0].target_id, None);
    }

    #[test]
    fn valid_cached_target_skips_acquisition_and_is_retained() {
        let mut soldier = unit(1, 10, UnitKind::Soldier, 10.0);
        soldier.cached_target_id = Some(2);
        soldier.cached_target_until = 500;
        let mut cfg = config();
        cfg.target_candidate_limit = 0;
        let mut request = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: cfg,
            units: vec![soldier, unit(2, 20, UnitKind::Robot, 11.0)],
            humans: vec![],
            start_index: 0,
        };
        assert_eq!(schedule_tick(&mut request).schedules[0].target_id, Some(2));
    }

    #[test]
    fn attacker_keeps_a_locked_target_outside_detection_range() {
        let mut attacker = unit(1, 10, UnitKind::Attacker, 10.0);
        attacker.cached_target_id = Some(2);
        attacker.cached_target_until = 500;
        let mut request = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![attacker, unit(2, 20, UnitKind::Robot, 80.0)],
            humans: vec![],
            start_index: 0,
        };
        assert_eq!(schedule_tick(&mut request).schedules[0].target_id, Some(2));
    }

    #[test]
    fn defender_drops_a_target_that_leaves_detection_range() {
        let mut defender = unit(1, 10, UnitKind::Defender, 10.0);
        defender.cached_target_id = Some(2);
        defender.cached_target_until = 500;
        defender.order_x = 10.0;
        defender.order_y = 10.0;
        let mut request = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![defender, unit(2, 20, UnitKind::Robot, 23.0)],
            humans: vec![],
            start_index: 0,
        };
        assert_eq!(schedule_tick(&mut request).schedules[0].target_id, None);
    }

    #[test]
    fn target_acquisition_is_staggered_by_unit_id() {
        let mut soldier = unit(1, 10, UnitKind::Soldier, 10.0);
        soldier.cached_target_until = 900;
        let mut request = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: config(),
            units: vec![soldier, unit(2, 20, UnitKind::Robot, 11.0)],
            humans: vec![],
            start_index: 0,
        };
        let deferred = schedule_tick(&mut request);
        assert_eq!(deferred.schedules[0].target_id, None);
        assert_eq!(deferred.schedules[0].interval_ms, 50);
        request.now = 1050;
        assert_eq!(schedule_tick(&mut request).schedules[0].target_id, Some(2));
    }

    #[test]
    fn tick_budget_resumes_from_a_fair_cursor() {
        let mut cfg = config();
        cfg.tick_budget_us = 0;
        let mut request = TickRequest {
            protocol_version: 1,
            now: 1000,
            detection_range: 7.0,
            intermediate_radius: 36.0,
            config: cfg,
            units: (0..100)
                .map(|id| unit(id + 1, 10, UnitKind::Robot, id as f32))
                .collect(),
            humans: vec![],
            start_index: 7,
        };
        let response = schedule_tick(&mut request);
        assert_eq!(response.schedules.len(), 32);
        assert_eq!(response.next_cursor, 39);
    }

    #[test]
    fn tile_index_finds_nearby_non_allied_tiles_and_tracks_obstacles() {
        let mut owners = vec![10; 16 * 16];
        owners[2] = 0;
        owners[3] = 20;
        owners[16] = 0;
        let mut obstacles = std::collections::HashSet::new();
        let mut index = TileTargetIndex::default();
        index.rebuild(16, 16, &obstacles);
        assert_eq!(
            index.nearest_non_allied(0.5, 0.5, 10, &owners),
            Some((0.5, 1.5))
        );
        assert_eq!(
            index.nearest_non_allied_candidates(0.5, 0.5, 10, &owners, 3),
            vec![(0.5, 1.5), (2.5, 0.5), (3.5, 0.5)]
        );

        obstacles.insert(2);
        index.set_obstacle(2, true);
        assert_eq!(
            index.nearest_non_allied(0.5, 0.5, 10, &owners),
            Some((0.5, 1.5))
        );
        assert_eq!(
            index.nearest_allied(2.5, 0.5, 10, &owners),
            Some((1.5, 0.5))
        );

        // Ownership is read from the authoritative owner array, so a capture
        // immediately inverts the same index query without rebuilding it.
        owners[1] = 20;
        owners[3] = 10;
        assert_eq!(
            index.nearest_allied(3.5, 0.5, 10, &owners),
            Some((3.5, 0.5))
        );
        assert_eq!(
            index.nearest_non_allied(3.5, 0.5, 10, &owners),
            Some((1.5, 0.5))
        );
    }

    #[test]
    fn wandering_prefers_frontiers_without_making_them_mandatory() {
        let width = 32;
        let height = 32;
        let mut owners = vec![0; (width * height) as usize];
        for y in 0..height {
            for x in 0..16 {
                owners[(y * width + x) as usize] = 10;
            }
        }
        let obstacles = std::collections::HashSet::new();
        let mut frontier_choices = 0;
        let mut adventure_choices = 0;
        for decision in 0..128 {
            let (dir_x, _) = choose_wander_direction(
                "soldier",
                1000 + decision * 97,
                15.5,
                16.5,
                (1.0, 0.0),
                10,
                width,
                height,
                &owners,
                &obstacles,
            );
            if dir_x.abs() < 0.8 {
                frontier_choices += 1;
            } else {
                adventure_choices += 1;
            }
        }
        assert!(frontier_choices > adventure_choices);
        assert!(adventure_choices > 0);
    }
}
