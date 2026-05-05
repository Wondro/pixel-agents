/// <reference lib="dom" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZONE_DEFAULT_COLORS } from '../src/constants.ts';
import {
  addZone,
  expandLayout,
  paintZone,
  setAgentZoneAssignment,
  setAllAgentsZoneAssignment,
} from '../src/office/editor/editorActions.ts';
import { OfficeState } from '../src/office/engine/officeState.ts';
import type { OfficeLayout, TileType as TileTypeVal } from '../src/office/types.ts';
import { TILE_SIZE, TileType } from '../src/office/types.ts';
import { getAppZoneAssignmentKey } from '../src/office/zoneAssignments.ts';

function makeLayout(cols = 4, rows = 3): OfficeLayout {
  const tiles = new Array<TileTypeVal>(cols * rows).fill(TileType.FLOOR_1);
  return {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    tileColors: new Array(cols * rows).fill(null),
    zones: [],
    zoneTiles: new Array(cols * rows).fill(null),
    allAgentZoneLabels: [],
    agentZoneAssignments: {},
  };
}

test('zone paint persists and follows layout expansion', () => {
  let layout = addZone(makeLayout(), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = paintZone(layout, 0, 1, 'Alpha');

  assert.equal(layout.zoneTiles?.[4], 'Alpha');
  assert.equal(paintZone(layout, 0, 1, 'Alpha'), layout);

  const cleared = paintZone(layout, 0, 1, null);
  assert.equal(cleared.zoneTiles?.[4], null);

  const expanded = expandLayout(layout, 'left');
  assert.ok(expanded);
  assert.equal(expanded.layout.cols, 5);
  assert.equal(expanded.layout.zoneTiles?.[1 + 1 * 5], 'Alpha');
});

test('agent zone assignment is exclusive per base agent', () => {
  let layout = addZone(makeLayout(), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = addZone(layout, 'Beta', ZONE_DEFAULT_COLORS[1]);
  layout = setAgentZoneAssignment(layout, 1, 'Alpha', true);
  layout = setAgentZoneAssignment(layout, 1, 'Beta', true);

  assert.deepEqual(layout.agentZoneAssignments?.['1'], ['Beta']);
});

test('base agents and spawned subagents are limited to assigned zone or rest tiles', () => {
  let layout = addZone(makeLayout(), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = addZone(layout, 'Beta', ZONE_DEFAULT_COLORS[1]);
  layout = paintZone(layout, 1, 1, 'Alpha');
  layout = paintZone(layout, 2, 1, 'Beta');
  layout = setAgentZoneAssignment(layout, 1, 'Alpha', true);

  const officeState = new OfficeState(layout);
  officeState.addAgent(1, 0, 0, undefined, true);

  const agent = officeState.characters.get(1);
  assert.ok(agent);
  agent.tileCol = 0;
  agent.tileRow = 1;
  agent.x = agent.tileCol * TILE_SIZE + TILE_SIZE / 2;
  agent.y = agent.tileRow * TILE_SIZE + TILE_SIZE / 2;
  agent.path = [];

  assert.equal(officeState.isTileAllowedForAgent(1, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(1, 0, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(1, 2, 1), false);
  assert.equal(officeState.walkToTile(1, 2, 1), false);
  assert.equal(officeState.walkToTile(1, 0, 2), true);

  const subagentId = officeState.addSubagent(1, 'task-1');
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 0, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 2, 1), false);
});

test('app zone assignment persists across new runtime agent ids', () => {
  const appKey = getAppZoneAssignmentKey('Daedum-agent-team');
  assert.ok(appKey);

  let layout = addZone(makeLayout(), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = addZone(layout, 'Beta', ZONE_DEFAULT_COLORS[1]);
  layout = paintZone(layout, 1, 1, 'Alpha');
  layout = paintZone(layout, 2, 1, 'Beta');
  layout = setAgentZoneAssignment(layout, appKey, 'Alpha', true);

  const officeState = new OfficeState(layout);
  officeState.addAgent(42, 0, 0, undefined, true, undefined, 'Daedum-agent-team');

  assert.equal(officeState.isTileAllowedForAgent(42, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(42, 0, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(42, 2, 1), false);

  const subagentId = officeState.addSubagent(42, 'spawn-1');
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 2, 1), false);

  officeState.removeAgent(42);
  officeState.addAgent(99, 0, 0, undefined, true, undefined, 'Daedum-agent-team');
  assert.equal(officeState.isTileAllowedForAgent(99, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(99, 2, 1), false);
});

test('team name can provide the persistent app zone key when no app name is present', () => {
  const appKey = getAppZoneAssignmentKey('Daedum-agent-team');
  assert.ok(appKey);

  let layout = addZone(makeLayout(), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = addZone(layout, 'Beta', ZONE_DEFAULT_COLORS[1]);
  layout = paintZone(layout, 1, 1, 'Alpha');
  layout = paintZone(layout, 2, 1, 'Beta');
  layout = setAgentZoneAssignment(layout, appKey, 'Alpha', true);

  const officeState = new OfficeState(layout);
  officeState.addAgent(7, 0, 0, undefined, true);
  const agent = officeState.characters.get(7);
  assert.ok(agent);
  agent.tileCol = 2;
  agent.tileRow = 1;
  agent.x = agent.tileCol * TILE_SIZE + TILE_SIZE / 2;
  agent.y = agent.tileRow * TILE_SIZE + TILE_SIZE / 2;

  officeState.setTeamInfo(7, 'Daedum-agent-team', undefined, true);

  assert.equal(agent.appName, 'Daedum-agent-team');
  assert.equal(officeState.isTileAllowedForAgent(7, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(7, 2, 1), false);
  assert.notDeepEqual({ col: agent.tileCol, row: agent.tileRow }, { col: 2, row: 1 });
});

test('all-agent zones are shared by constrained base agents and subagents', () => {
  let layout = addZone(makeLayout(5, 3), 'Alpha', ZONE_DEFAULT_COLORS[0]);
  layout = addZone(layout, 'Beta', ZONE_DEFAULT_COLORS[1]);
  layout = addZone(layout, 'Break room', ZONE_DEFAULT_COLORS[2]);
  layout = paintZone(layout, 1, 1, 'Alpha');
  layout = paintZone(layout, 2, 1, 'Beta');
  layout = paintZone(layout, 3, 1, 'Break room');
  layout = setAgentZoneAssignment(layout, 1, 'Alpha', true);
  layout = setAllAgentsZoneAssignment(layout, 'Break room', true);

  const officeState = new OfficeState(layout);
  officeState.addAgent(1, 0, 0, undefined, true);

  const agent = officeState.characters.get(1);
  assert.ok(agent);
  agent.tileCol = 0;
  agent.tileRow = 1;
  agent.x = agent.tileCol * TILE_SIZE + TILE_SIZE / 2;
  agent.y = agent.tileRow * TILE_SIZE + TILE_SIZE / 2;
  agent.path = [];

  assert.equal(officeState.isTileAllowedForAgent(1, 1, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(1, 3, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(1, 2, 1), false);
  assert.equal(officeState.walkToTile(1, 3, 1), true);

  const subagentId = officeState.addSubagent(1, 'task-2');
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 3, 1), true);
  assert.equal(officeState.isTileAllowedForAgent(subagentId, 2, 1), false);
});

test('subagent clear can preserve background spawned agents', () => {
  const officeState = new OfficeState(makeLayout());
  officeState.addAgent(1, 0, 0, undefined, true);

  const backgroundSubagentId = officeState.addSubagent(1, 'spawn-agent');
  const foregroundSubagentId = officeState.addSubagent(1, 'temporary-task');

  officeState.removeSubagentsExcept(1, new Set(['spawn-agent']));

  assert.equal(officeState.getSubagentId(1, 'spawn-agent'), backgroundSubagentId);
  assert.equal(officeState.characters.get(backgroundSubagentId)?.matrixEffect, 'spawn');
  assert.equal(officeState.getSubagentId(1, 'temporary-task'), null);
  assert.equal(officeState.characters.get(foregroundSubagentId)?.matrixEffect, 'despawn');

  assert.equal(officeState.addSubagent(1, 'spawn-agent'), backgroundSubagentId);
});
