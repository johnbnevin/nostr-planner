# App Icons

Place your app icon files here. Tauri requires the following files for bundling:

| File | Size | Format |
|------|------|--------|
| `32x32.png` | 32×32 | PNG |
| `128x128.png` | 128×128 | PNG |
| `128x128@2x.png` | 256×256 | PNG |
| `icon.icns` | — | macOS icon bundle |
| `icon.ico` | — | Windows icon |
| `icon.png` | 512×512 | Base PNG (used for Linux + mobile) |

## Generating Icons

If you have a source `icon.png` (512×512 or larger), Tauri can auto-generate all formats:

```bash
cd apps/planner
npx tauri icon src-tauri/icons/icon.png
```

This writes all required formats into `src-tauri/icons/`.
