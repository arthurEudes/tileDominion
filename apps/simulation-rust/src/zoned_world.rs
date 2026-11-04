use crate::UnitState;
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ZoneKey {
    pub level: u8,
    pub x: u16,
    pub y: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct ZoneBounds {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

impl ZoneBounds {
    fn contains(self, x: f32, y: f32) -> bool {
        x >= self.min_x && x < self.max_x && y >= self.min_y && y < self.max_y
    }

    fn distance_to(self, x: f32, y: f32) -> f32 {
        self.distance_squared_to(x, y).sqrt()
    }

    fn distance_squared_to(self, x: f32, y: f32) -> f32 {
        let dx = if x < self.min_x {
            self.min_x - x
        } else if x >= self.max_x {
            x - self.max_x
        } else {
            0.0
        };
        let dy = if y < self.min_y {
            self.min_y - y
        } else if y >= self.max_y {
            y - self.max_y
        } else {
            0.0
        };
        dx * dx + dy * dy
    }
}

#[derive(Clone, Debug)]
pub struct GhostUnit {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

impl From<&UnitState> for GhostUnit {
    fn from(unit: &UnitState) -> Self {
        Self {
            id: unit.id,
            x: unit.x,
            y: unit.y,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Zone {
    pub key: ZoneKey,
    pub units: Vec<UnitState>,
    pub ghosts: Vec<GhostUnit>,
}

pub struct ZonedWorld {
    width: f32,
    height: f32,
    root_size: f32,
    split_threshold: usize,
    merge_threshold: usize,
    max_level: u8,
    zones: BTreeMap<ZoneKey, Zone>,
    unit_locations: HashMap<u32, (ZoneKey, usize)>,
    ghost_memberships: HashMap<u32, Vec<ZoneKey>>,
    ghost_halo: Option<f32>,
    ghost_topology_dirty: bool,
}

impl ZonedWorld {
    pub fn new(
        width: f32,
        height: f32,
        root_size: f32,
        split_threshold: usize,
        merge_threshold: usize,
        max_level: u8,
    ) -> Self {
        assert!(root_size > 0.0);
        assert!(merge_threshold < split_threshold);
        Self {
            width,
            height,
            root_size,
            split_threshold,
            merge_threshold,
            max_level,
            zones: BTreeMap::new(),
            unit_locations: HashMap::new(),
            ghost_memberships: HashMap::new(),
            ghost_halo: None,
            ghost_topology_dirty: true,
        }
    }

    pub fn zones(&self) -> impl Iterator<Item = &Zone> {
        self.zones.values()
    }

    pub fn unit_count(&self) -> usize {
        self.zones.values().map(|zone| zone.units.len()).sum()
    }

    pub fn units(&self) -> impl Iterator<Item = &UnitState> {
        self.zones.values().flat_map(|zone| zone.units.iter())
    }

    pub fn network_snapshot(&self, x: f32, y: f32, radius: f32) -> Vec<UnitState> {
        let radius_sq = radius * radius;
        self.zones
            .iter()
            .filter(|(key, _)| self.bounds(**key).distance_to(x, y) <= radius)
            .flat_map(|(_, zone)| zone.units.iter())
            .filter(|unit| {
                let dx = unit.x - x;
                let dy = unit.y - y;
                dx * dx + dy * dy <= radius_sq
            })
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &u32) -> Option<&UnitState> {
        let (zone, index) = *self.unit_locations.get(id)?;
        self.zones.get(&zone)?.units.get(index)
    }

    pub fn get_mut(&mut self, id: &u32) -> Option<&mut UnitState> {
        let (zone, index) = *self.unit_locations.get(id)?;
        self.zones.get_mut(&zone)?.units.get_mut(index)
    }

    pub fn apply_delta(
        &mut self,
        upserts: impl IntoIterator<Item = UnitState>,
        removals: impl IntoIterator<Item = u32>,
    ) {
        for id in removals {
            self.remove(id);
        }
        for unit in upserts {
            self.remove(unit.id);
            let key = self.leaf_key(unit.x, unit.y);
            let zone = self.zones.entry(key).or_insert_with(|| Zone {
                key,
                units: Vec::new(),
                ghosts: Vec::new(),
            });
            let index = zone.units.len();
            let id = unit.id;
            zone.units.push(unit);
            self.unit_locations.insert(id, (key, index));
        }
        self.zones.retain(|_, zone| !zone.units.is_empty());
        if self.rebalance() {
            self.rebuild_index();
        }
    }

    pub fn apply_authoritative_delta(
        &mut self,
        upserts: impl IntoIterator<Item = UnitState>,
        removals: impl IntoIterator<Item = u32>,
    ) {
        for id in removals {
            self.remove(id);
        }
        let mut created = Vec::new();
        for incoming in upserts {
            if let Some(unit) = self.get_mut(&incoming.id) {
                unit.owner_id = incoming.owner_id;
                unit.kind = incoming.kind;
                unit.order = incoming.order;
                unit.order_x = incoming.order_x;
                unit.order_y = incoming.order_y;
                unit.blocks_movement = incoming.blocks_movement;
                unit.bastion_type = incoming.bastion_type;
                unit.source_bastion_id = incoming.source_bastion_id;
            } else {
                created.push(incoming);
            }
        }
        if !created.is_empty() {
            self.apply_delta(created, std::iter::empty());
        }
    }

    pub fn remove(&mut self, id: u32) -> Option<UnitState> {
        self.remove_ghost_memberships(id);
        let (key, index) = self.unit_locations.remove(&id)?;
        let zone = self.zones.get_mut(&key)?;
        let removed = zone.units.swap_remove(index);
        if let Some(swapped) = zone.units.get(index) {
            self.unit_locations.insert(swapped.id, (key, index));
        }
        Some(removed)
    }

    pub fn replace_units(&mut self, units: impl IntoIterator<Item = UnitState>) {
        self.zones.clear();
        self.unit_locations.clear();
        self.ghost_memberships.clear();
        for unit in units {
            let key = self.root_key(unit.x, unit.y);
            self.zones
                .entry(key)
                .or_insert_with(|| Zone {
                    key,
                    units: Vec::new(),
                    ghosts: Vec::new(),
                })
                .units
                .push(unit);
        }
        self.rebalance();
        self.rebuild_index();
    }

    pub fn parallel_for_each_unit<F>(&mut self, operation: F)
    where
        F: Fn(&mut UnitState) + Send + Sync,
    {
        self.zones
            .par_iter_mut()
            .for_each(|(_, zone)| zone.units.iter_mut().for_each(&operation));
    }

    pub fn reconcile_transfers(&mut self) {
        let bounds = self
            .zones
            .keys()
            .map(|key| (*key, self.bounds(*key)))
            .collect::<BTreeMap<_, _>>();
        let mut units = Vec::new();
        for (key, zone) in &mut self.zones {
            let bounds = bounds[key];
            let mut index = 0;
            while index < zone.units.len() {
                if bounds.contains(zone.units[index].x, zone.units[index].y) {
                    index += 1;
                } else {
                    let moved = zone.units.swap_remove(index);
                    self.unit_locations.remove(&moved.id);
                    if let Some(swapped) = zone.units.get(index) {
                        self.unit_locations.insert(swapped.id, (*key, index));
                    }
                    units.push(moved);
                }
            }
        }
        if units.is_empty() {
            return;
        }
        let leaves = self.zones.keys().copied().collect::<Vec<_>>();
        for unit in units {
            let key = leaves
                .iter()
                .copied()
                .find(|key| self.bounds(*key).contains(unit.x, unit.y))
                .unwrap_or_else(|| self.root_key(unit.x, unit.y));
            let zone = self.zones.entry(key).or_insert_with(|| Zone {
                key,
                units: Vec::new(),
                ghosts: Vec::new(),
            });
            let index = zone.units.len();
            let id = unit.id;
            zone.units.push(unit);
            self.unit_locations.insert(id, (key, index));
        }
        self.zones.retain(|_, zone| !zone.units.is_empty());
        if self.rebalance() {
            self.rebuild_index();
        }
    }

    pub fn refresh_ghosts(&mut self, halo: f32) {
        if self.ghost_halo != Some(halo) || self.ghost_topology_dirty {
            for zone in self.zones.values_mut() {
                zone.ghosts.clear();
            }
            self.ghost_memberships.clear();
            self.ghost_halo = Some(halo);
            self.ghost_topology_dirty = false;
        }
        let bounds = self
            .zones
            .keys()
            .map(|key| (*key, self.bounds(*key)))
            .collect::<Vec<_>>();
        let sources = self
            .zones
            .iter()
            .flat_map(|(key, zone)| {
                zone.units
                    .iter()
                    .map(|unit| (unit.id, unit.x, unit.y, *key))
            })
            .collect::<Vec<_>>();
        let halo_sq = halo * halo;
        for (id, x, y, source_key) in sources {
            let memberships = bounds
                .iter()
                .filter_map(|(key, zone_bounds)| {
                    (*key != source_key && zone_bounds.distance_squared_to(x, y) <= halo_sq)
                        .then_some(*key)
                })
                .collect::<Vec<_>>();
            let unchanged = self
                .ghost_memberships
                .get(&id)
                .is_some_and(|previous| previous == &memberships);
            if unchanged {
                for key in &memberships {
                    if let Some(ghost) = self
                        .zones
                        .get_mut(key)
                        .and_then(|zone| zone.ghosts.iter_mut().find(|ghost| ghost.id == id))
                    {
                        ghost.x = x;
                        ghost.y = y;
                    }
                }
                continue;
            }
            self.remove_ghost_memberships(id);
            for key in &memberships {
                if let Some(zone) = self.zones.get_mut(key) {
                    zone.ghosts.push(GhostUnit { id, x, y });
                }
            }
            self.ghost_memberships.insert(id, memberships);
        }
    }

    pub fn rebuild_ghosts(&mut self, halo: f32) {
        self.ghost_topology_dirty = true;
        self.refresh_ghosts(halo);
    }

    pub fn into_units(self) -> Vec<UnitState> {
        self.zones
            .into_values()
            .flat_map(|zone| zone.units)
            .collect()
    }

    fn rebalance(&mut self) -> bool {
        let mut changed = false;
        loop {
            let overloaded = self
                .zones
                .iter()
                .find(|(key, zone)| {
                    zone.units.len() > self.split_threshold && key.level < self.max_level
                })
                .map(|(key, _)| *key);
            let Some(key) = overloaded else { break };
            self.split(key);
            changed = true;
        }
        changed |= self.merge_sparse_siblings();
        if changed {
            self.ghost_topology_dirty = true;
        }
        changed
    }

    fn split(&mut self, key: ZoneKey) {
        let Some(zone) = self.zones.remove(&key) else {
            return;
        };
        for unit in zone.units {
            let child = self.child_key(key, unit.x, unit.y);
            self.zones
                .entry(child)
                .or_insert_with(|| Zone {
                    key: child,
                    units: Vec::new(),
                    ghosts: Vec::new(),
                })
                .units
                .push(unit);
        }
    }

    fn merge_sparse_siblings(&mut self) -> bool {
        let mut changed = false;
        for level in (1..=self.max_level).rev() {
            let mut parents = BTreeMap::<ZoneKey, Vec<ZoneKey>>::new();
            for key in self.zones.keys().filter(|key| key.level == level) {
                parents.entry(Self::parent(*key)).or_default().push(*key);
            }
            for (parent, children) in parents {
                if children.len() < 2 {
                    continue;
                }
                let count = children
                    .iter()
                    .map(|key| self.zones.get(key).map_or(0, |zone| zone.units.len()))
                    .sum::<usize>();
                if count > self.merge_threshold {
                    continue;
                }
                let mut units = Vec::with_capacity(count);
                for child in children {
                    if let Some(zone) = self.zones.remove(&child) {
                        units.extend(zone.units);
                    }
                }
                self.zones.insert(
                    parent,
                    Zone {
                        key: parent,
                        units,
                        ghosts: Vec::new(),
                    },
                );
                changed = true;
            }
        }
        changed
    }

    fn root_key(&self, x: f32, y: f32) -> ZoneKey {
        ZoneKey {
            level: 0,
            x: (x.clamp(0.0, self.width - f32::EPSILON) / self.root_size) as u16,
            y: (y.clamp(0.0, self.height - f32::EPSILON) / self.root_size) as u16,
        }
    }

    fn leaf_key(&self, x: f32, y: f32) -> ZoneKey {
        self.zones
            .keys()
            .copied()
            .find(|key| self.bounds(*key).contains(x, y))
            .unwrap_or_else(|| self.root_key(x, y))
    }

    fn rebuild_index(&mut self) {
        self.unit_locations.clear();
        for (key, zone) in &self.zones {
            for (index, unit) in zone.units.iter().enumerate() {
                self.unit_locations.insert(unit.id, (*key, index));
            }
        }
    }

    fn remove_ghost_memberships(&mut self, id: u32) {
        let Some(memberships) = self.ghost_memberships.remove(&id) else {
            return;
        };
        for key in memberships {
            if let Some(zone) = self.zones.get_mut(&key) {
                if let Some(index) = zone.ghosts.iter().position(|ghost| ghost.id == id) {
                    zone.ghosts.swap_remove(index);
                }
            }
        }
    }

    fn child_key(&self, parent: ZoneKey, x: f32, y: f32) -> ZoneKey {
        let bounds = self.bounds(parent);
        let middle_x = (bounds.min_x + bounds.max_x) * 0.5;
        let middle_y = (bounds.min_y + bounds.max_y) * 0.5;
        ZoneKey {
            level: parent.level + 1,
            x: parent.x * 2 + u16::from(x >= middle_x),
            y: parent.y * 2 + u16::from(y >= middle_y),
        }
    }

    fn parent(key: ZoneKey) -> ZoneKey {
        ZoneKey {
            level: key.level - 1,
            x: key.x / 2,
            y: key.y / 2,
        }
    }

    fn bounds(&self, key: ZoneKey) -> ZoneBounds {
        let size = self.root_size / (1_u32 << key.level) as f32;
        ZoneBounds {
            min_x: key.x as f32 * size,
            min_y: key.y as f32 * size,
            max_x: ((key.x + 1) as f32 * size).min(self.width),
            max_y: ((key.y + 1) as f32 * size).min(self.height),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UnitKind;

    fn unit(id: u32, x: f32, y: f32) -> UnitState {
        UnitState {
            id,
            owner_id: 1,
            kind: UnitKind::Robot,
            x,
            y,
            hp: 10.0,
            dir_x: 0.0,
            dir_y: 0.0,
            order: "wander".into(),
            order_x: x,
            order_y: y,
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

    #[test]
    fn splits_hot_zones_and_preserves_every_entity() {
        let mut world = ZonedWorld::new(256.0, 256.0, 64.0, 4, 2, 3);
        world.replace_units((0..20).map(|id| unit(id, 10.0 + id as f32 * 0.1, 10.0)));
        assert_eq!(world.unit_count(), 20);
        assert!(world.zones().any(|zone| zone.key.level > 0));
    }

    #[test]
    fn transfers_entities_and_builds_boundary_ghosts() {
        let mut world = ZonedWorld::new(256.0, 256.0, 64.0, 8, 2, 2);
        world.replace_units([unit(1, 63.5, 20.0), unit(2, 64.5, 20.0)]);
        world.rebuild_ghosts(2.0);
        assert!(world.zones().all(|zone| zone.ghosts.len() == 1));
        world.parallel_for_each_unit(|unit| {
            if unit.id == 1 {
                unit.x = 65.0;
            }
        });
        world.reconcile_transfers();
        assert_eq!(world.unit_count(), 2);
        assert_eq!(world.zones().count(), 1);
    }

    #[test]
    fn direct_index_survives_swap_removal_and_transfer() {
        let mut world = ZonedWorld::new(256.0, 256.0, 64.0, 8, 2, 2);
        world.replace_units([
            unit(1, 10.0, 20.0),
            unit(2, 11.0, 20.0),
            unit(3, 70.0, 20.0),
        ]);
        assert_eq!(world.remove(1).map(|unit| unit.id), Some(1));
        assert_eq!(world.get(&2).map(|unit| unit.id), Some(2));
        world.get_mut(&2).unwrap().x = 70.0;
        world.reconcile_transfers();
        assert_eq!(world.get(&2).map(|unit| unit.x), Some(70.0));
        assert_eq!(world.get(&3).map(|unit| unit.id), Some(3));
    }

    #[test]
    fn incremental_ghost_refresh_removes_units_that_leave_a_halo() {
        let mut world = ZonedWorld::new(256.0, 256.0, 64.0, 8, 2, 2);
        world.replace_units([unit(1, 63.5, 20.0), unit(2, 64.5, 20.0)]);
        world.refresh_ghosts(2.0);
        assert!(world.zones().all(|zone| zone.ghosts.len() == 1));
        world.get_mut(&1).unwrap().x = 10.0;
        world.refresh_ghosts(2.0);
        assert_eq!(
            world
                .zones()
                .flat_map(|zone| zone.ghosts.iter())
                .filter(|ghost| ghost.id == 1)
                .count(),
            0,
        );
    }

    #[test]
    fn authoritative_upserts_preserve_rust_runtime_state() {
        let mut world = ZonedWorld::new(256.0, 256.0, 64.0, 8, 2, 2);
        world.replace_units([unit(1, 10.0, 20.0)]);
        {
            let current = world.get_mut(&1).unwrap();
            current.x = 24.0;
            current.hp = 7.0;
            current.next_think = 9_000;
        }
        let mut stale_command = unit(1, 10.0, 20.0);
        stale_command.owner_id = 2;
        stale_command.order = "attack".into();
        stale_command.order_x = 80.0;
        stale_command.order_y = 90.0;
        world.apply_authoritative_delta([stale_command], []);
        let current = world.get(&1).unwrap();
        assert_eq!(
            (current.x, current.hp, current.next_think),
            (24.0, 7.0, 9_000)
        );
        assert_eq!((current.owner_id, current.order.as_str()), (2, "attack"));
        assert_eq!((current.order_x, current.order_y), (80.0, 90.0));
    }
}
