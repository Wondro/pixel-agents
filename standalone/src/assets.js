import fs from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

const PNG_ALPHA_THRESHOLD = 2;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_TILE_SIZE = 16;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'];

function rgbaToHex(r, g, b, a) {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const rgb = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`.toUpperCase();
  return a >= 255 ? rgb : `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

function pixelAt(png, x, y) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return '';
  const idx = (y * png.width + x) * 4;
  return rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function listSortedFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((filename) => ({ filename, match: pattern.exec(filename) }))
    .filter((entry) => entry.match)
    .map(({ filename, match }) => ({ filename, index: Number.parseInt(match[1], 10) }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.filename);
}

function pngToSpriteData(pngBuffer, width, height) {
  try {
    const png = PNG.sync.read(pngBuffer);
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => pixelAt(png, x, y)),
    );
  } catch {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
  }
}

function parseWallPng(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const sprites = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
    sprites.push(
      Array.from({ length: WALL_PIECE_HEIGHT }, (_, y) =>
        Array.from({ length: WALL_PIECE_WIDTH }, (_, x) => pixelAt(png, ox + x, oy + y)),
      ),
    );
  }
  return sprites;
}

function decodeCharacterPng(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const charData = { down: [], up: [], right: [] };
  for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
    const dir = CHARACTER_DIRECTIONS[dirIdx];
    const rowOffsetY = dirIdx * CHAR_FRAME_H;
    charData[dir] = Array.from({ length: CHAR_FRAMES_PER_ROW }, (_, frame) => {
      const frameOffsetX = frame * CHAR_FRAME_W;
      return Array.from({ length: CHAR_FRAME_H }, (_, y) =>
        Array.from({ length: CHAR_FRAME_W }, (_, x) =>
          pixelAt(png, frameOffsetX + x, rowOffsetY + y),
        ),
      );
    });
  }
  return charData;
}

function decodeFloorPng(pngBuffer) {
  return pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
}

function flattenManifest(node, inherited) {
  if (node.type === 'asset') {
    const orientation = node.orientation ?? inherited.orientation;
    const state = node.state ?? inherited.state;
    return [
      {
        id: node.id,
        name: inherited.name,
        label: inherited.name,
        category: inherited.category,
        file: node.file,
        width: node.width,
        height: node.height,
        footprintW: node.footprintW,
        footprintH: node.footprintH,
        isDesk: inherited.category === 'desks',
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        groupId: inherited.groupId,
        ...(orientation ? { orientation } : {}),
        ...(state ? { state } : {}),
        ...(node.mirrorSide ? { mirrorSide: true } : {}),
        ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
        ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
        ...(node.frame !== undefined ? { frame: node.frame } : {}),
      },
    ];
  }

  const results = [];
  for (const member of node.members ?? []) {
    const childProps = { ...inherited };
    if (node.groupType === 'rotation' && node.rotationScheme) {
      childProps.rotationScheme = node.rotationScheme;
    }
    if (node.groupType === 'state') {
      if (node.orientation) childProps.orientation = node.orientation;
      if (node.state) childProps.state = node.state;
    }
    if (node.groupType === 'animation') {
      const orient = node.orientation ?? inherited.orientation ?? '';
      const st = node.state ?? inherited.state ?? '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
      if (node.state) childProps.state = node.state;
    }
    if (node.orientation && !childProps.orientation) {
      childProps.orientation = node.orientation;
    }
    results.push(...flattenManifest(member, childProps));
  }
  return results;
}

function buildFurnitureCatalog(assetsDir) {
  const furnitureDir = path.join(assetsDir, 'furniture');
  if (!fs.existsSync(furnitureDir)) return [];

  const catalog = [];
  const dirs = fs
    .readdirSync(furnitureDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const folderName of dirs) {
    const manifestPath = path.join(furnitureDir, folderName, 'manifest.json');
    const manifest = readJson(manifestPath);
    if (!manifest) continue;

    if (manifest.type === 'asset') {
      const file = manifest.file ?? `${manifest.id}.png`;
      catalog.push({
        id: manifest.id,
        name: manifest.name,
        label: manifest.name,
        category: manifest.category,
        file,
        furniturePath: `furniture/${folderName}/${file}`,
        width: manifest.width,
        height: manifest.height,
        footprintW: manifest.footprintW,
        footprintH: manifest.footprintH,
        isDesk: manifest.category === 'desks',
        canPlaceOnWalls: manifest.canPlaceOnWalls,
        canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
        backgroundTiles: manifest.backgroundTiles,
        groupId: manifest.id,
      });
      continue;
    }

    const inherited = {
      groupId: manifest.id,
      name: manifest.name,
      category: manifest.category,
      canPlaceOnWalls: manifest.canPlaceOnWalls,
      canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
      backgroundTiles: manifest.backgroundTiles,
      ...(manifest.rotationScheme ? { rotationScheme: manifest.rotationScheme } : {}),
    };
    const assets = flattenManifest(
      {
        type: 'group',
        groupType: manifest.groupType,
        rotationScheme: manifest.rotationScheme,
        members: manifest.members,
      },
      inherited,
    );
    for (const asset of assets) {
      catalog.push({ ...asset, furniturePath: `furniture/${folderName}/${asset.file}` });
    }
  }

  return catalog;
}

function buildAssetIndex(assetsDir) {
  let defaultLayout = null;
  let bestRevision = 0;
  if (fs.existsSync(assetsDir)) {
    for (const filename of fs.readdirSync(assetsDir)) {
      const match = /^default-layout-(\d+)\.json$/i.exec(filename);
      if (!match) continue;
      const revision = Number.parseInt(match[1], 10);
      if (revision > bestRevision) {
        bestRevision = revision;
        defaultLayout = filename;
      }
    }
    if (!defaultLayout && fs.existsSync(path.join(assetsDir, 'default-layout.json'))) {
      defaultLayout = 'default-layout.json';
    }
  }

  return {
    characters: listSortedFiles(path.join(assetsDir, 'characters'), /^char_(\d+)\.png$/i),
    floors: listSortedFiles(path.join(assetsDir, 'floors'), /^floor_(\d+)\.png$/i),
    walls: listSortedFiles(path.join(assetsDir, 'walls'), /^wall_(\d+)\.png$/i),
    defaultLayout,
  };
}

export function loadCharacterSprites(assetsDir, assetIndex) {
  const files = assetIndex.characters ?? [];
  if (files.length === 0) return null;
  return {
    characters: files.map((filename) =>
      decodeCharacterPng(fs.readFileSync(path.join(assetsDir, 'characters', filename))),
    ),
  };
}

export function loadFloorTiles(assetsDir, assetIndex) {
  const files = assetIndex.floors ?? [];
  if (files.length === 0) return null;
  return {
    sprites: files.map((filename) =>
      decodeFloorPng(fs.readFileSync(path.join(assetsDir, 'floors', filename))),
    ),
  };
}

export function loadWallTiles(assetsDir, assetIndex) {
  const files = assetIndex.walls ?? [];
  if (files.length === 0) return null;
  return {
    sets: files.map((filename) =>
      parseWallPng(fs.readFileSync(path.join(assetsDir, 'walls', filename))),
    ),
  };
}

export function loadFurnitureAssets(assetsDir) {
  const catalog =
    readJson(path.join(assetsDir, 'furniture-catalog.json')) ?? buildFurnitureCatalog(assetsDir);
  const sprites = {};

  for (const entry of catalog) {
    const relativePath = entry.furniturePath ?? path.join('furniture', entry.groupId, entry.file);
    const filePath = path.join(assetsDir, relativePath);
    if (!fs.existsSync(filePath)) continue;
    sprites[entry.id] = pngToSpriteData(fs.readFileSync(filePath), entry.width, entry.height);
  }

  return catalog.length > 0 ? { catalog, sprites } : null;
}

export function loadDefaultLayout(assetsDir, assetIndex) {
  const defaultLayout = assetIndex.defaultLayout;
  if (!defaultLayout) return null;

  const layout = readJson(path.join(assetsDir, defaultLayout));
  if (!layout) return null;

  const revision = /^default-layout-(\d+)\.json$/i.exec(defaultLayout)?.[1];
  if (revision && !layout.layoutRevision) {
    layout.layoutRevision = Number.parseInt(revision, 10);
  }
  return layout;
}

export function loadStandaloneAssets(webviewDist) {
  const assetsDir = path.join(webviewDist, 'assets');
  const assetIndex =
    readJson(path.join(assetsDir, 'asset-index.json')) ?? buildAssetIndex(assetsDir);

  return {
    assetsDir,
    defaultLayout: loadDefaultLayout(assetsDir, assetIndex),
    characterSprites: loadCharacterSprites(assetsDir, assetIndex),
    floorTiles: loadFloorTiles(assetsDir, assetIndex),
    wallTiles: loadWallTiles(assetsDir, assetIndex),
    furnitureAssets: loadFurnitureAssets(assetsDir),
  };
}
