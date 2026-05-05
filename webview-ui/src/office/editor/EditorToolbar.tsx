import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { ColorPicker } from '../../components/ui/ColorPicker.js';
import { ItemSelect } from '../../components/ui/ItemSelect.js';
import type { ColorValue } from '../../components/ui/types.js';
import { CANVAS_FALLBACK_TILE_COLOR, ZONE_DEFAULT_COLORS } from '../../constants.js';
import { getColorizedSprite } from '../colorize.js';
import { getColorizedFloorSprite, getFloorPatternCount, hasFloorSprites } from '../floorTiles.js';
import type { FurnitureCategory, LoadedAssetData } from '../layout/furnitureCatalog.js';
import {
  buildDynamicCatalog,
  getActiveCategories,
  getCatalogByCategory,
} from '../layout/furnitureCatalog.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { AgentZoneAssignments, TileType as TileTypeVal, ZoneDefinition } from '../types.js';
import { EditTool } from '../types.js';
import { getWallSetCount, getWallSetPreviewSprite } from '../wallTiles.js';

export interface BaseAgentOption {
  id: number;
  label: string;
}

interface EditorToolbarProps {
  activeTool: EditTool;
  selectedTileType: TileTypeVal;
  selectedFurnitureType: string;
  selectedFurnitureUid: string | null;
  selectedZoneLabel: string | null;
  selectedFurnitureColor: ColorValue | null;
  floorColor: ColorValue;
  wallColor: ColorValue;
  selectedWallSet: number;
  zones: ZoneDefinition[];
  allAgentZoneLabels: string[];
  agentZoneAssignments: AgentZoneAssignments;
  baseAgents: BaseAgentOption[];
  onToolChange: (tool: EditTool) => void;
  onTileTypeChange: (type: TileTypeVal) => void;
  onFloorColorChange: (color: ColorValue) => void;
  onWallColorChange: (color: ColorValue) => void;
  onWallSetChange: (setIndex: number) => void;
  onSelectedFurnitureColorChange: (color: ColorValue | null) => void;
  onFurnitureTypeChange: (type: string) => void;
  onSelectedZoneChange: (label: string | null) => void;
  onAddZone: (label: string, color: string) => void;
  onRemoveZone: (label: string) => void;
  onAgentZoneAssignmentChange: (agentId: number, zoneLabel: string, assigned: boolean) => void;
  onAllAgentsZoneAssignmentChange: (zoneLabel: string, assigned: boolean) => void;
  loadedAssets?: LoadedAssetData;
}

const THUMB_ZOOM = 2;

const DEFAULT_FURNITURE_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

export function EditorToolbar({
  activeTool,
  selectedTileType,
  selectedFurnitureType,
  selectedFurnitureUid,
  selectedZoneLabel,
  selectedFurnitureColor,
  floorColor,
  wallColor,
  selectedWallSet,
  zones,
  allAgentZoneLabels,
  agentZoneAssignments,
  baseAgents,
  onToolChange,
  onTileTypeChange,
  onFloorColorChange,
  onWallColorChange,
  onWallSetChange,
  onSelectedFurnitureColorChange,
  onFurnitureTypeChange,
  onSelectedZoneChange,
  onAddZone,
  onRemoveZone,
  onAgentZoneAssignmentChange,
  onAllAgentsZoneAssignmentChange,
  loadedAssets,
}: EditorToolbarProps) {
  const [activeCategory, setActiveCategory] = useState<FurnitureCategory>('desks');
  const [showColor, setShowColor] = useState(false);
  const [showWallColor, setShowWallColor] = useState(false);
  const [showFurnitureColor, setShowFurnitureColor] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');

  // Build dynamic catalog from loaded assets
  useEffect(() => {
    if (loadedAssets) {
      try {
        console.log(
          `[EditorToolbar] Building dynamic catalog with ${loadedAssets.catalog.length} assets...`,
        );
        const success = buildDynamicCatalog(loadedAssets);
        console.log(`[EditorToolbar] Catalog build result: ${success}`);

        // Reset to first available category if current doesn't exist
        const activeCategories = getActiveCategories();
        if (activeCategories.length > 0) {
          const firstCat = activeCategories[0]?.id;
          if (firstCat) {
            console.log(`[EditorToolbar] Setting active category to: ${firstCat}`);
            setActiveCategory(firstCat);
          }
        }
      } catch (err) {
        console.error(`[EditorToolbar] Error building dynamic catalog:`, err);
      }
    }
  }, [loadedAssets]);

  // For selected furniture: use existing color or default
  const effectiveColor = selectedFurnitureColor ?? DEFAULT_FURNITURE_COLOR;

  const categoryItems = getCatalogByCategory(activeCategory);

  const patternCount = getFloorPatternCount();
  // Wall is TileType 0, floor patterns are 1..patternCount
  const floorPatterns = Array.from({ length: patternCount }, (_, i) => i + 1);

  const thumbSize = 42; // 2x for items

  const isFloorActive = activeTool === EditTool.TILE_PAINT || activeTool === EditTool.EYEDROPPER;
  const isWallActive = activeTool === EditTool.WALL_PAINT;
  const isZoneActive = activeTool === EditTool.ZONE_PAINT;
  const isEraseActive = activeTool === EditTool.ERASE;
  const isFurnitureActive =
    activeTool === EditTool.FURNITURE_PLACE || activeTool === EditTool.FURNITURE_PICK;
  const nextZoneColor = ZONE_DEFAULT_COLORS[zones.length % ZONE_DEFAULT_COLORS.length];

  const submitNewZone = () => {
    const trimmed = newZoneName.trim();
    if (!trimmed) return;
    onAddZone(trimmed, nextZoneColor);
    setNewZoneName('');
  };

  const assignedToZone = (agentId: number, label: string) =>
    (agentZoneAssignments[String(agentId)] ?? []).includes(label);
  const allAgentsAssignedToZone = (label: string) => allAgentZoneLabels.includes(label);

  return (
    <div className="absolute bottom-76 left-10 z-10 pixel-panel p-4 flex flex-col-reverse gap-4 max-w-[calc(100vw-20px)]">
      {/* Tool row — at the bottom */}
      <div className="flex gap-4 flex-wrap">
        <Button
          variant={isFurnitureActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.FURNITURE_PLACE)}
          title="Place furniture"
        >
          Furniture
        </Button>
        <Button
          variant={isFloorActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.TILE_PAINT)}
          title="Paint floor tiles"
        >
          Floor
        </Button>
        <Button
          variant={isWallActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.WALL_PAINT)}
          title="Paint walls (click to toggle)"
        >
          Wall
        </Button>
        <Button
          variant={isZoneActive ? 'active' : 'default'}
          size="md"
          onClick={() => {
            if (zones.length > 0 && selectedZoneLabel === null) {
              onSelectedZoneChange(zones[0].label);
            } else {
              onToolChange(EditTool.ZONE_PAINT);
            }
          }}
          title="Paint agent zones"
        >
          Zones
        </Button>
        <Button
          variant={isEraseActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.ERASE)}
          title="Erase tiles to void"
        >
          Erase
        </Button>
      </div>

      {/* Sub-panel: Floor tiles — stacked bottom-to-top via column-reverse */}
      {isFloorActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Color toggle + Pick — just above tool row */}
          <div className="flex gap-4 items-center">
            <Button
              variant={showColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowColor((v) => !v)}
              title="Adjust floor color"
            >
              Color
            </Button>
            <Button
              variant={activeTool === EditTool.EYEDROPPER ? 'active' : 'ghost'}
              size="sm"
              onClick={() => onToolChange(EditTool.EYEDROPPER)}
              title="Pick floor pattern + color from existing tile"
            >
              Pick
            </Button>
          </div>

          {/* Color controls (collapsible) — above Wall/Color/Pick */}
          {showColor && <ColorPicker value={floorColor} onChange={onFloorColorChange} colorize />}

          {/* Floor pattern horizontal carousel — at the top */}
          <div className="carousel">
            {floorPatterns.map((patIdx) => (
              <ItemSelect
                key={patIdx}
                width={32}
                height={32}
                selected={selectedTileType === patIdx}
                onClick={() => onTileTypeChange(patIdx as TileTypeVal)}
                title={`Floor ${patIdx}`}
                deps={[patIdx, floorColor]}
                draw={(ctx, w, h) => {
                  if (!hasFloorSprites()) {
                    ctx.fillStyle = CANVAS_FALLBACK_TILE_COLOR;
                    ctx.fillRect(0, 0, w, h);
                    return;
                  }
                  const sprite = getColorizedFloorSprite(patIdx, floorColor);
                  ctx.drawImage(getCachedSprite(sprite, THUMB_ZOOM), 0, 0);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sub-panel: Wall — stacked bottom-to-top via column-reverse */}
      {isWallActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Color toggle — just above tool row */}
          <div className="flex gap-4 items-center">
            <Button
              variant={showWallColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowWallColor((v) => !v)}
              title="Adjust wall color"
            >
              Color
            </Button>
          </div>

          {/* Color controls (collapsible) */}
          {showWallColor && <ColorPicker value={wallColor} onChange={onWallColorChange} colorize />}

          {/* Wall set picker — horizontal carousel at the top */}
          {getWallSetCount() > 0 && (
            <div className="carousel">
              {Array.from({ length: getWallSetCount() }, (_, i) => (
                <ItemSelect
                  key={i}
                  width={32}
                  height={64}
                  selected={selectedWallSet === i}
                  onClick={() => onWallSetChange(i)}
                  title={`Wall ${i + 1}`}
                  deps={[i, wallColor]}
                  draw={(ctx, w, h) => {
                    const sprite = getWallSetPreviewSprite(i);
                    if (!sprite) {
                      ctx.fillStyle = CANVAS_FALLBACK_TILE_COLOR;
                      ctx.fillRect(0, 0, w, h);
                      return;
                    }
                    const cacheKey = `wall-preview-${i}-${wallColor.h}-${wallColor.s}-${wallColor.b}-${wallColor.c}`;
                    const colorized = getColorizedSprite(cacheKey, sprite, {
                      ...wallColor,
                      colorize: true,
                    });
                    ctx.drawImage(getCachedSprite(colorized, THUMB_ZOOM), 0, 0);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sub-panel: Furniture — stacked bottom-to-top via column-reverse */}
      {isZoneActive && (
        <div className="flex flex-col-reverse gap-4 max-w-[760px]">
          <div className="flex gap-4 items-center flex-wrap">
            <input
              value={newZoneName}
              onChange={(e) => setNewZoneName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewZone();
              }}
              placeholder="Zone name"
              className="bg-bg-dark border-2 border-border text-text px-6 py-2 text-sm outline-none min-w-[160px]"
            />
            <Button
              variant={newZoneName.trim() ? 'accent' : 'disabled'}
              size="sm"
              onClick={submitNewZone}
              disabled={!newZoneName.trim()}
            >
              Add
            </Button>
          </div>

          {zones.length > 0 && (
            <div className="flex gap-6 overflow-x-auto pb-2">
              {zones.map((zone) => {
                const isAllAgentsZone = allAgentsAssignedToZone(zone.label);
                const assignedAgents = baseAgents.filter((agent) =>
                  assignedToZone(agent.id, zone.label),
                );
                const availableAgents = baseAgents.filter(
                  (agent) => !isAllAgentsZone && !assignedToZone(agent.id, zone.label),
                );
                return (
                  <div
                    key={zone.label}
                    className={`border-2 bg-bg-dark p-4 min-w-[220px] max-w-[280px] ${
                      selectedZoneLabel === zone.label ? 'border-accent' : 'border-border'
                    }`}
                  >
                    <div className="flex items-center gap-4 mb-4">
                      <button
                        type="button"
                        onClick={() => onSelectedZoneChange(zone.label)}
                        className="w-12 h-12 border-2 border-white/40 cursor-pointer shrink-0"
                        style={{ backgroundColor: zone.color }}
                        title={zone.label}
                      />
                      <button
                        type="button"
                        onClick={() => onSelectedZoneChange(zone.label)}
                        className="text-left text-sm text-text truncate flex-1 cursor-pointer"
                        title={zone.label}
                      >
                        {zone.label}
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemoveZone(zone.label)}
                        title="Remove zone"
                        className="px-4"
                      >
                        X
                      </Button>
                    </div>

                    <div className="flex flex-col gap-3">
                      {isAllAgentsZone && (
                        <div className="flex items-center gap-4 bg-btn-bg border border-border px-4 py-2">
                          <span className="text-xs truncate flex-1" title="All agents">
                            All agents
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onAllAgentsZoneAssignmentChange(zone.label, false)}
                            title="Remove all agents"
                            className="px-3"
                          >
                            X
                          </Button>
                        </div>
                      )}

                      {assignedAgents.map((agent) => (
                        <div
                          key={agent.id}
                          className="flex items-center gap-4 bg-btn-bg border border-border px-4 py-2"
                        >
                          <span className="text-xs truncate flex-1" title={agent.label}>
                            {agent.label}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onAgentZoneAssignmentChange(agent.id, zone.label, false)}
                            title="Remove agent"
                            className="px-3"
                          >
                            X
                          </Button>
                        </div>
                      ))}

                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value === 'all') {
                            onAllAgentsZoneAssignmentChange(zone.label, true);
                            return;
                          }
                          const id = Number(e.target.value);
                          if (Number.isFinite(id)) {
                            onAgentZoneAssignmentChange(id, zone.label, true);
                          }
                        }}
                        className="bg-bg border-2 border-border text-text px-4 py-2 text-sm outline-none"
                        disabled={isAllAgentsZone || availableAgents.length === 0}
                        title="Assign agent"
                      >
                        <option value="">
                          {isAllAgentsZone
                            ? 'All agents'
                            : availableAgents.length === 0
                              ? 'No agents'
                              : 'Assign agent'}
                        </option>
                        {!isAllAgentsZone && <option value="all">All agents</option>}
                        {availableAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {isFurnitureActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Category tabs + Pick — just above tool row */}
          <div className="flex gap-4 flex-wrap items-center">
            {getActiveCategories().map((cat) => (
              <Button
                key={cat.id}
                variant={activeCategory === cat.id ? 'active' : 'ghost'}
                size="sm"
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </Button>
            ))}
            <div className="w-[1px] h-14 bg-white/15 mx-2 shrink-0" />
            <Button
              variant={activeTool === EditTool.FURNITURE_PICK ? 'active' : 'ghost'}
              size="sm"
              onClick={() => onToolChange(EditTool.FURNITURE_PICK)}
              title="Pick furniture type from placed item"
            >
              Pick
            </Button>
          </div>
          {/* Furniture items — single-row horizontal carousel at 2x */}
          <div className="carousel">
            {categoryItems.map((entry) => (
              <ItemSelect
                key={entry.type}
                width={thumbSize}
                height={thumbSize}
                selected={selectedFurnitureType === entry.type}
                onClick={() => onFurnitureTypeChange(entry.type)}
                title={entry.label}
                deps={[entry.type, entry.sprite]}
                draw={(ctx, w, h) => {
                  const cached = getCachedSprite(entry.sprite, 2);
                  const scale = Math.min(w / cached.width, h / cached.height) * 0.85;
                  const dw = cached.width * scale;
                  const dh = cached.height * scale;
                  ctx.drawImage(cached, (w - dw) / 2, (h - dh) / 2, dw, dh);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Selected furniture color panel — shows when any placed furniture item is selected */}
      {selectedFurnitureUid && (
        <div className="flex flex-col-reverse gap-4">
          <div className="flex gap-4 items-center">
            <Button
              variant={showFurnitureColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowFurnitureColor((v) => !v)}
              title="Adjust selected furniture color"
            >
              Color
            </Button>
            {selectedFurnitureColor && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSelectedFurnitureColorChange(null)}
                title="Remove color (restore original)"
              >
                Clear
              </Button>
            )}
          </div>
          {showFurnitureColor && (
            <ColorPicker
              value={effectiveColor}
              onChange={onSelectedFurnitureColorChange}
              showColorizeToggle
            />
          )}
        </div>
      )}
    </div>
  );
}
