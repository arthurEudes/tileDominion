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
        (dx * dx + dy * dy).sqrt()
    }
}

#[derive(Clone, Debug)]
pub struct GhostUnit {
    pub state: UnitState,
}

impl From<&UnitState> for GhostUnit {
    fn from(unit: &UnitState) -> Self {
        Self { state: unit.clone() }
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
    unit_zones: HashMap<u32, ZoneKey>,
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
            unit_zones: HashMap::new(),
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

    pub fn get(&self, id: &u32) -> Option<&UnitState> {
        let zone = self.unit_zones.get(id)?;
        self.zones.get(zone)?.units.iter().find(|unit| unit.id == *id)
    }

    pub fn get_mut(&mut self, id: &u32) -> Option<&mut UnitState> {
        let zone = *self.unit_zones.get(id)?;
        self.zones
            .get_mut(&zone)?
            .units
            .iter_mut()
            .find(|unit| unit.id == *id)
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
            self.zones
                .entry(key)
                .or_insert_with(|| Zone { key, units: Vec::new(), ghosts: Vec::new() })
                .units
                .push(unit);
        }
        self.zones.retain(|_, zone| !zone.units.is_empty());
        self.rebalance();
        self.rebuild_index();
    }

    pub fn remove(&mut self, id: u32) -> Option<UnitState> {
        let key = self.unit_zones.remove(&id)?;
        let zone = self.zones.get_mut(&key)?;
        let index = zone.units.iter().position(|unit| unit.id == id)?;
        Some(zone.units.swap_remove(index))
    }

    pub fn replace_units(&mut self, units: impl IntoIterator<Item = UnitState>) {
        self.zones.clear();
        self.unit_zones.clear();
        for unit in units {
            let key = self.root_key(unit.x, unit.y);
            self.zones
                .entry(key)
                .or_insert_with(|| Zone { key, units: Vec::new(), ghosts: Vec::new() })
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
        let units = self
            .zones
            .values_mut()
            .flat_map(|zone| std::mem::take(&mut zone.units))
            .collect::<Vec<_>>();
        let leaves = self.zones.keys().copied().collect::<Vec<_>>();
        for unit in units {
            let key = leaves
                .iter()
                .copied()
                .find(|key| self.bounds(*key).contains(unit.x, unit.y))
                .unwrap_or_else(|| self.root_key(unit.x, unit.y));
            self.zones
                .entry(key)
                .or_insert_with(|| Zone { key, units: Vec::new(), ghosts: Vec::new() })
                .units
                .push(unit);
        }
        self.zones.retain(|_, zone| !zone.units.is_empty());
        self.rebalance();
        self.rebuild_index();
    }

    pub fn rebuild_ghosts(&mut self, halo: f32) {
        let sources = self
            .zones
            .values()
            .flat_map(|zone| zone.units.iter().map(GhostUnit::from))
            .collect::<Vec<_>>();
        let bounds = self
            .zones
            .keys()
            .map(|key| (*key, self.bounds(*key)))
            .collect::<BTreeMap<_, _>>();
        self.zones.par_iter_mut().for_each(|(key, zone)| {
            let zone_bounds = bounds[key];
            zone.ghosts.clear();
            zone.ghosts.extend(sources.iter().filter_map(|unit| {
                (!zone_bounds.contains(unit.state.x, unit.state.y)
                    && zone_bounds.distance_to(unit.state.x, unit.state.y) <= halo)
                    .then(|| unit.clone())
            }));
        });
    }

    pub fn into_units(self) -> Vec<UnitState> {
        self.zones
            .into_values()
            .flat_map(|zone| zone.units)
            .collect()
    }

    fn rebalance(&mut self) {
        loop {
            let overloaded = self
                .zones
                .iter()
                .find(|(key, zone)| zone.units.len() > self.split_threshold && key.level < self.max_level)
                .map(|(key, _)| *key);
            let Some(key) = overloaded else { break };
            self.split(key);
        }
        self.merge_sparse_siblings();
    }

    fn split(&mut self, key: ZoneKey) {
        let Some(zone) = self.zones.remove(&key) else { return };
        for unit in zone.units {
            let child = self.child_key(key, unit.x, unit.y);
            self.zones
                .entry(child)
                .or_insert_with(|| Zone { key: child, units: Vec::new(), ghosts: Vec::new() })
                .units
                .push(unit);
        }
    }

    fn merge_sparse_siblings(&mut self) {
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
                self.zones.insert(parent, Zone { key: parent, units, ghosts: Vec::new() });
            }
        }
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
        self.unit_zones.clear();
        for (key, zone) in &self.zones {
            for unit in &zone.units {
                self.unit_zones.insert(unit.id, *key);
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
        ZoneKey { level: key.level - 1, x: key.x / 2, y: key.y / 2 }
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
            id, owner_id: 1, kind: UnitKind::Robot, x, y, hp: 10.0,
            dir_x: 0.0, dir_y: 0.0, order: "wander".into(), order_x: x, order_y: y,
            next_think: 0, next_simulation_at: 0, last_simulated_at: 0,
            cached_target_id: None, cached_target_until: 0, blocks_movement: false,
            last_attack: 0, capture_tile: None, capture_since: 0, bastion_type: 0,
            next_produce: 0, source_bastion_id: None,
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
            if unit.id == 1 { unit.x = 65.0; }
        });
        world.reconcile_transfers();
        assert_eq!(world.unit_count(), 2);
        assert_eq!(world.zones().count(), 1);
    }
}
