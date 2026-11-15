import * as migration_20261001_171717_initial from './20261001_171717_initial';

export const migrations = [
  {
    up: migration_20261001_171717_initial.up,
    down: migration_20261001_171717_initial.down,
    name: '20261001_171717_initial'
  },
];
