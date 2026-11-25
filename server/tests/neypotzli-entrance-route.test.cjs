// From server/: node --test tests/neypotzli-entrance-route.test.cjs
// Issue #188: the Cam Torum landing to the Neypotzli entrance is one real
// 91-tile walk, but RSMod's source-anchored 128x128 search map made the loc
// click report that the player cannot reach it instead of walking the tunnel.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
const { RsmodRouteFinding } = require('../dist/game/model/movement/path/RsmodRouteFinding');
const { Location } = require('../dist/game/model/Location');

const ENTRANCE = 51375;
const LANDING = [1439, 9509, 1];
const GATE = [1439, 9600, 1];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  RegionManager.init();
  RegionManager.loadMapFiles(LANDING[0], LANDING[1]);
  RegionManager.loadMapFiles(GATE[0], GATE[1]);
});

test('the Cam Torum landing routes over the tunnel to the Neypotzli entrance', () => {
  const gate = MapObjects.get(ENTRANCE, new Location(...GATE), null);
  assert.ok(gate, 'the real 51375 entrance is placed at 1439,9600,1');
  const definition = ObjectDefinition.forId(ENTRANCE);
  assert.equal(gate.getType(), 10, 'a rectangular 2x2 loc');
  assert.equal(gate.getFace(), 0);
  assert.deepEqual([definition.getSizeX(), definition.getSizeY()], [2, 2]);
  assert.equal(definition.getInteractions()[0], 'Pass-through');

  const [srcX, srcY, level] = LANDING;
  assert.equal(GATE[1] - srcY, 91, 'the gate origin is beyond the old 64-tile source half-window');
  const finder = new RsmodRouteFinding((x, y, z, area) => RegionManager.getClipping(x, y, z, area));
  const route = finder.findRoute({
    level,
    srcX,
    srcY,
    srcSize: 1,
    destX: gate.getLocation().getX(),
    destY: gate.getLocation().getY(),
    destWidth: definition.getSizeX(),
    destLength: definition.getSizeY(),
    locAngle: gate.getFace(),
    locShape: 10,
    moveNear: true,
    maxWaypoints: 25,
    privateArea: null,
  });
  assert.equal(route.success, true, 'the open tunnel is a real route');
  assert.equal(route.alternative, false, 'the fitted search reaches the gate itself');
  assert.deepEqual([route.endX, route.endY], [1439, 9599], 'south approach tile');
  assert.ok(route.waypoints.length > 0);
  assert.deepEqual(route.waypoints.at(-1), { x: 1439, y: 9599, z: 1 });

  assert.equal(finder.reachedAbsolute({
    level,
    srcX: route.endX,
    srcY: route.endY,
    srcSize: 1,
    destX: gate.getLocation().getX(),
    destY: gate.getLocation().getY(),
    destWidth: definition.getSizeX(),
    destLength: definition.getSizeY(),
    locAngle: gate.getFace(),
    locShape: 10,
    privateArea: null,
  }), true, 'the route endpoint operates the entrance');
});
