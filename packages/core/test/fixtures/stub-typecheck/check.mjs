/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/telescope` and `@adonisjs/*` by NAME, with each stub rendered into the
 * file it actually generates, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves, and reaches them through RELATIVE imports —
 * so it never resolves the `exports` map a consumer resolves, and never sees the barrel at all. The
 * sibling `stubs.spec.ts` asserts each stub is non-empty, has its `exports()` header and carries no
 * backtick; all three are text assertions that cannot see a type error.
 *
 * That leaves a stub free to reference a shape the real types reject, or a symbol the package stopped
 * exporting, while the whole suite stays green. The failure mode is not hypothetical:
 * `@adonis-agora/agent` shipped a migration whose `up()` did not compile in a consumer app, because
 * its structural `rawQuery` declared `bindings?: unknown[]` — not assignable in either direction to
 * Lucid's `RawQueryBindings`, so no per-connection client satisfied it. Its whole suite stayed green.
 *
 * This repo has already been bitten one rung lower: all seven config stubs shipped as ZERO-BYTE files
 * for three minor releases, so `node ace add` wrote an empty `config/telescope.ts`. `stubs.spec.ts`
 * now catches empty; this catches "exists, has content, and does not compile" — the next rung up.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED declarations a consumer installs — the shipped
 * `dist/**\/*.d.ts` — not `src/`, which a check run inside this repo would otherwise pick up.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
/** The stubs a consumer actually installs. `copy:stubs` mirrors `stubs/` here at build time. */
const distStubsRoot = join(pkgRoot, 'dist/stubs');

/**
 * Every stub this package publishes, with the path `configure` writes it to. All eight emit typed
 * TypeScript: the seven config files each import a `defineConfig` from a different subpath of the
 * package (so between them they exercise every published entry point a consumer configures against),
 * and the migration imports Lucid's `BaseSchema`.
 *
 * Keep this list exhaustive. `configure.ts` publishes exactly these; a stub added there and not here
 * is unchecked, which is the whole failure this harness exists to prevent — so `stub-typecheck.spec.ts`
 * cross-checks the list against the stubs directory rather than trusting it.
 */
const STUBS = [
  { stub: 'config/telescope.stub' },
  { stub: 'config/telescope_watchers.stub' },
  { stub: 'config/telescope_ui.stub' },
  { stub: 'config/telescope_ai.stub' },
  { stub: 'config/telescope_alerts.stub' },
  { stub: 'config/telescope_mcp.stub' },
  { stub: 'config/telescope_cpu_profiling.stub' },
  {
    stub: 'database/migrations/create_telescope_entries_table.stub',
    // Pure DDL: no commented-out example block to enable.
    uncomment: false,
  },
];

/**
 * Render every stub through the REAL AdonisJS stub engine — the same `Stub.prepare()` that
 * `node ace configure` drives — over the copy in `dist/stubs`, which is what a consumer installs.
 *
 * RENDERING is the check that matters, not pattern-matching. A stub body is compiled into a Tempura
 * template literal, so an unescaped backtick or `${` anywhere in the prose makes `configure` THROW
 * instead of writing a file. A regex renderer never executes that step, so it reports a healthy stub
 * for a package whose `configure` cannot write anything — the exact false-green this gate exists to
 * prevent. Driving the engine also un-escapes an escaped backtick or `${` exactly as the generator
 * does, so prose is free to use them.
 *
 * The blast radius is worse than "writes nothing": `configure` runs `updateRcFile` FIRST and only
 * then renders, so one throwing stub leaves `adonisrc.ts` naming providers whose config files were
 * never written. That app does not boot.
 *
 * `prepare()` rather than `generate()`: it renders the template and resolves the
 * `exports({ to: app.configPath(...) })` destination without writing to disk, so the destination
 * each file lands on is the generator's own answer rather than one restated here.
 */
async function renderAll(appRoot) {
  const app = new AppFactory().create(new URL(`file://${appRoot}/`), () => {});
  await app.init();
  const stubs = await app.stubs.create();

  const rendered = [];
  for (const spec of STUBS) {
    const stub = await stubs.build(spec.stub, { source: distStubsRoot });
    const prepared = await stub.prepare({});
    rendered.push({ ...spec, destination: prepared.destination, contents: prepared.contents });
  }
  return rendered;
}

/**
 * Re-enable every commented-out example in a config stub, so the gate covers what a user actually
 * uncomments.
 *
 * Without this the gate is nearly worthless here: across the seven config stubs there are 28 lines of
 * live code and 101 commented config lines, so ~78% of the surface these stubs document —
 * `storage.lucid`, `redact.perType`, the `sampling` rules, every alert rule shape, `dashboardAuth`,
 * `requestCapture`, `queueManager` — would drift out of the published types with the gate still
 * green. The commented block IS the documentation; it has to compile.
 *
 * Strips exactly ONE `//` level from each line outside a `/** … *\/` prose block. That is what makes
 * it safe: a doubly-commented line (a nested optional example) stays a comment, and the JSDoc prose
 * that explains each key is untouched.
 *
 * Fails hard when a stub yields nothing to uncomment — that means the anchors moved (the stub was
 * reformatted, or its examples became live code) and this transform is silently checking nothing,
 * which is the exact failure it exists to prevent.
 */
function uncomment(rendered, stub) {
  let inProse = false;
  let enabled = 0;

  const out = rendered.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!inProse && (trimmed.startsWith('/**') || trimmed.startsWith('/*'))) {
      inProse = !trimmed.includes('*/');
      return line;
    }
    if (inProse) {
      if (trimmed.includes('*/')) inProse = false;
      return line;
    }
    const match = line.match(/^(\s*)\/\/ ?(.*)$/);
    if (!match) return line;
    enabled++;
    return `${match[1]}${match[2]}`;
  });

  if (enabled === 0) {
    throw new Error(
      `nothing to uncomment in ${stub} — the commented-example anchors moved, so this variant would check nothing. Re-point the transform rather than setting uncomment:false on the stub.`,
    );
  }
  return out.join('\n');
}

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve
 * every peer they import (`@adonisjs/lucid` for the migration, `@adonisjs/core` for the env module)
 * plus anything the published declarations transitively reference (luxon via Lucid's types). Scoped
 * directories are recreated as real directories so `@adonis-agora/telescope` can be added alongside
 * without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer
 * dependency is picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → `dist/**/*.d.ts`.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/telescope'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'telescope-stub-typecheck-'));
try {
  /**
   * `imports` is what makes `#start/env` resolve — the subpath-import map every AdonisJS app
   * declares. `config/telescope_ai.stub` reads its API key through it, so without this the stub
   * would fail here for a reason that has nothing to do with the package's types.
   */
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'telescope-stub-typecheck-app',
        type: 'module',
        private: true,
        imports: { '#start/*': './start/*.js' },
      },
      null,
      2,
    ),
  );
  linkDependencies(appRoot);

  /**
   * The env module `node ace configure` leaves in a real app, carrying every var the stubs read.
   *
   * Optionality is modelled the way a consumer would actually declare it, and that is load-bearing:
   * a var feeding a REQUIRED field (`channels[].url`, `credentials.basic.password`,
   * `dashboardAuth.secret`) must be `Env.schema.string()`, because `string | undefined` does not
   * satisfy `string`. A var feeding an optional field stays `.optional()` — which is exactly what
   * the AI stub's own comment instructs, so this also pins that `apiKey` accepts what that
   * declaration produces. Get this wrong in either direction and the gate reports a drift that is
   * really just a mis-modelled scratch app.
   */
  mkdirSync(join(appRoot, 'start'), { recursive: true });
  writeFileSync(
    join(appRoot, 'start/env.ts'),
    [
      "import { Env } from '@adonisjs/core/env'",
      '',
      "export default await Env.create(new URL('../', import.meta.url), {",
      '  ANTHROPIC_API_KEY: Env.schema.string.optional(),',
      '  TELESCOPE_UI_TOKEN: Env.schema.string.optional(),',
      '  TELESCOPE_MCP_TOKEN: Env.schema.string.optional(),',
      '  TELESCOPE_UI_PASSWORD: Env.schema.string(),',
      '  TELESCOPE_DASHBOARD_SECRET: Env.schema.string(),',
      '  TELESCOPE_SLACK_WEBHOOK: Env.schema.string(),',
      '  TELESCOPE_ALERT_WEBHOOK: Env.schema.string(),',
      '})',
      '',
    ].join('\n'),
  );

  /**
   * Stand-ins for the app-owned identifiers the stubs' commented examples reference. A real consumer
   * has these in their own app; the gate needs them declared so an uncommented example fails on a
   * TYPE drift rather than on a name it was never going to resolve here.
   */
  mkdirSync(join(appRoot, 'app'), { recursive: true });
  writeFileSync(
    join(appRoot, 'app/example_bindings.ts'),
    [
      "import type { AnthropicMessagesClient } from '@adonis-agora/telescope/ai'",
      '',
      'export declare const myModelClient: AnthropicMessagesClient',
      '',
      'export declare class User {',
      '  static verifyCredentials(username: string, password: string): Promise<User>',
      '  readonly id: number',
      '  readonly fullName: string',
      '  readonly isAdmin: boolean',
      '}',
      '',
    ].join('\n'),
  );

  for (const spec of await renderAll(appRoot)) {
    // The destination the ENGINE resolved, so the file lands exactly where `configure` puts it.
    mkdirSync(join(spec.destination, '..'), { recursive: true });
    writeFileSync(spec.destination, spec.contents);

    // …and a second copy with every commented example switched on. Same module, same imports, plus
    // the app-owned bindings those examples reference.
    if (spec.uncomment !== false) {
      writeFileSync(
        spec.destination.replace(/\.ts$/, '_all_options.ts'),
        [
          "import { myModelClient, User } from '../app/example_bindings.js'",
          'void myModelClient;',
          'void User;',
          uncomment(spec.contents, spec.stub),
        ].join('\n'),
      );
    }
  }

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig`
   * sets. Both matter — NodeNext is what makes the package's `exports` map (and therefore its
   * subpath declarations) the thing being resolved, and `strict` is what turns a variance mismatch
   * from a silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          experimentalDecorators: true,
        },
        include: ['config/**/*.ts', 'database/**/*.ts', 'start/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

const variants = STUBS.filter((spec) => spec.uncomment !== false).length;
console.log(
  `stub typecheck: OK (${STUBS.length} stubs, ${variants} also with every commented example enabled)`,
);
