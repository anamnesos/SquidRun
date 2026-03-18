# Windows Electron `npm install` EBUSY Workaround

## Symptom

Running `npm install` inside `ui/` while SquidRun is open can fail on Windows with an `EBUSY` rename error against `ui/node_modules/electron/dist/icudtl.dat`.

## Cause

The live Electron process holds files in `ui/node_modules/electron/dist`, and npm's reify step tries to rename that package even when only adding a new dependency.

## Safe Workaround

1. Install the target package into an isolated prefix outside `ui/node_modules`:

```powershell
npm install <package> --prefix .squidrun\tmp\<temp-dir>
```

2. Copy the installed package into `ui/node_modules/<package>` and copy its temp `node_modules` tree into `ui/node_modules/<package>/node_modules`.

3. Verify from `ui/` with:

```powershell
npm ls <package>
node -e "require('<package>')"
```

## Notes

- This avoids touching the locked Electron package.
- If SquidRun is closed, a normal `npm install` in `ui/` should work again.
