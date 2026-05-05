---
name: add-asset
description: Generate Pixel Agents-compatible assets from a requested theme and item description. Use when the user invokes "/Add asset", asks to add/create/generate furniture, decor, electronics, floors, walls, characters, themed asset packs, or any new Pixel Agents raster assets; image creation must use the imagegen skill.
---

# Add Asset

## Required Context

Before creating files:

1. Read `.agents/agents/asset-creator.md`.
2. Read `docs/external-assets.md`.
3. Inspect relevant examples under `webview-ui/public/assets/`, especially similar furniture manifests.
4. Determine the requested theme and item description.

## Theme Decision

- If the theme is omitted, `default`, or `built-in`, create source assets under `webview-ui/public/assets/`.
- If the theme is not default, look for an external asset directory whose folder name matches the theme slug and uses this shape:

```text
<theme-folder>/
  assets/
    furniture/
```

- If no matching folder exists, create `external-assets/<theme-slug>/assets/` unless the user gave an explicit path.
- For non-default themes, remind the user to link the new directory in Pixel Agents via Settings -> Add Asset Directory.
- Do not hand-edit `dist/assets`; use it only to compare built/package output after a build.

## Image Generation Rule

Use the `imagegen` skill/tool for every new or substantially changed raster image. After generation, use deterministic processing only for cleanup: slicing, resizing, transparent background, palette cleanup, filename normalization, and manifest wiring.

## Asset Rules

- Match the Pixel Agents pixel-art office style and 16px tile grid.
- Use uppercase snake case for folder names, ids, and file stems.
- Put each furniture item in its own folder under `assets/furniture/<ITEM_ID>/`.
- Every furniture item must include front, side, and back views.
- Any item an agent can interact with must include at least 4 animation frames for the active/on/used/response state.
- For symmetric side views, use `rotationScheme: "3-way-mirror"` with a single side sprite and `mirrorSide: true`.
- For genuinely asymmetric left/right views, use a 4-way rotation manifest.
- Electronics and devices should normally include an `OFF` asset and an `ON` animation group.
- Small desktop props should set `canPlaceOnSurfaces: true`.
- Wall-mounted items should set `canPlaceOnWalls: true` and category `wall`.

## Workflow

1. Parse the request into:
   - `theme`
   - asset name
   - category
   - interaction/animation needs
   - expected views and dimensions
2. Create a file plan:
   - output root
   - item folder
   - PNG filenames
   - manifest structure
3. Generate the source image sheet with `imagegen`.
4. Produce exact transparent PNG sprites from the generated sheet.
5. Write `manifest.json` using the existing manifest format.
6. Validate manifests and image files:
   - referenced files exist
   - dimensions match manifest fields
   - ids are unique enough for the target theme
   - furniture has front, side, and back views
   - interactable assets have at least 4 frames
7. For default assets, run the narrowest practical build/test check, usually:

```bash
npm --prefix webview-ui test
npm --prefix webview-ui run build
```

8. For non-default external assets, validate the folder structure and explain the Settings -> Add Asset Directory linking step.

## Output Summary

End with:

- Theme and output directory.
- Files created or changed.
- Animation/view coverage.
- Verification run and result.
- Any manual step required, especially Add Asset Directory for non-default themes.
