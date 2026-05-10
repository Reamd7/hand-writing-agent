# Lesson 1: Project Architecture and Engineering Setup -- Reference Materials

## Primary Source: pi-mono Repository

- **Repository**: <https://github.com/earendil-works/pi-mono>
- **Root `package.json`**: defines `"type": "module"`, `"workspaces": ["packages/*"]`, and cross-package build scripts
- **`tsconfig.base.json`**: shared compiler options -- `"module": "Node16"`, `"strict": true`, `"declaration": true`, `"declarationMap": true`
- **`biome.json`**: formatting and linting configuration (replaces ESLint + Prettier)

### Key Source Files to Study

| File                                  | What to look for                                                        |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `/package.json`                       | `workspaces` field, `type: "module"`, build script ordering             |
| `/tsconfig.base.json`                 | Shared `compilerOptions` inherited by all packages                      |
| `/packages/ai/package.json`           | `exports` map with subpath exports, `"type": "module"`, dependency list |
| `/packages/agent/package.json`        | Depends on `@earendil-works/pi-ai`, minimal dependency surface          |
| `/packages/coding-agent/package.json` | Depends on `pi-ai`, `pi-agent-core`, and `pi-tui`; has `bin` field      |
| `/packages/tui/package.json`          | Standalone UI library, no dependency on other pi packages               |
| `/packages/web-ui/package.json`       | Standalone web component library                                        |

### Package Dependency Graph

```
pi-tui (standalone)       pi-ai (standalone)       pi-web-ui (standalone)
       \                  /    \                        /
        \                /      \                      /
         \              /        \                    /
          coding-agent  <--- agent-core              /
                \                                   /
                 `------ coding-agent (uses all) --'
```

Simplified:

```
ai  -->  agent  -->  coding-agent
tui  ------------>  coding-agent
web-ui  --------->  coding-agent
```

## npm Workspaces

- **Docs**: <https://docs.npmjs.com/cli/using-npm/workspaces>
- Declare `"workspaces": ["packages/*"]` in root `package.json`
- Single `node_modules/` at repo root; workspace packages are symlinked
- Cross-package dependencies resolved via symlinks -- no `npm link` needed
- Run scripts across all workspaces: `npm run build --workspaces`
- Run scripts in a specific workspace: `npm run build -w packages/ai`

## TypeScript Project References

- **Docs**: <https://www.typescriptlang.org/docs/handbook/project-references.html>
- Each package has its own `tsconfig.json` extending a shared `tsconfig.base.json`
- `"composite": true` enables incremental builds and `.d.ts` output caching
- `"references"` array declares build-time dependency edges between packages
- Build with `tsc --build` (or `tsc -b`) to compile in correct topological order
- `"declaration": true` and `"declarationMap": true` enable cross-package Go to Definition in editors

## Biome (Formatter + Linter)

- **Docs**: <https://biomejs.dev/>
- Single tool replacing ESLint + Prettier
- 97% Prettier-compatible formatting; 500+ lint rules
- Configuration via `biome.json` at repo root
- Key commands:
  - `npx @biomejs/biome check .` -- lint and format check
  - `npx @biomejs/biome check --write .` -- auto-fix
  - `npx @biomejs/biome format --write .` -- format only

## ESM (ECMAScript Modules) in Node.js

- **Docs**: <https://nodejs.org/api/esm.html>
- Enable via `"type": "module"` in `package.json`
- `import`/`export` syntax instead of `require()`/`module.exports`
- File extensions are mandatory in relative imports (e.g., `import { foo } from "./foo.js"`)
- Note: TypeScript source uses `.ts` but compiled output is `.js`; import paths reference the `.js` extension
- `__dirname` and `__filename` replaced by `import.meta.dirname` and `import.meta.filename`
- Top-level `await` is supported
- Subpath exports in `package.json` via the `"exports"` field control public API surface

## Additional Reading

- [Node.js Packages docs](https://nodejs.org/api/packages.html) -- `exports`, `type`, conditional exports
- [TypeScript Module Resolution](https://www.typescriptlang.org/docs/handbook/modules/theory.html) -- how TS resolves `.js` extensions in ESM
- [npm workspaces RFC](https://github.com/npm/rfcs/blob/main/implemented/0026-workspaces.md) -- original design rationale
