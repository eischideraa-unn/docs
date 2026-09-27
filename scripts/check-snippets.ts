import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

type Snippet = {
  attrs: string;
  code: string;
  file: string;
  index: number;
  lang: string;
  line: number;
};

const repoRoot = process.cwd();
const checkableLanguages = new Set(["ts", "tsx", "typescript", "js", "javascript"]);
const ignoredDirs = new Set([".git", ".github", "node_modules", ".next", "dist", "build"]);

const typedPrelude = `
import { Wraith, WraithAgent, Chain } from "@wraith-protocol/sdk";
declare global {
  var wraith: Wraith;
  var agent: WraithAgent;
  var chain: Chain;
  var wallet: {
    signMessage(message: string): Promise<string>;
    address?: string;
    [key: string]: any;
  };
  var apiKey: string;
  var message: string;
  var signature: string;
  var metaAddress: string;
  var recipient: string;
  var stealthAddress: string;
  var seed: Uint8Array;
  var sharedSecret: Uint8Array;
  var ephemeralPubKey: Uint8Array;
  var spendingPubKey: Uint8Array;
  var viewingPubKey: Uint8Array;
  var privateKey: Uint8Array | string;
  var publicKey: Uint8Array;
  var stellarKeypair: any;
  var payment: any;
  var announcement: any;
  var announcements: any;
  var config: any;
  var connector: any;
  var db: any;
  var detected: any;
  var hash: string;
  var keys: any;
  var nameRegistry: any;
  var publicClient: any;
  var address: any;
  var setError: any;
  var recipientSpendingPubKey: any;
  var recipientViewingPubKey: any;
  var response: any;
  var sender: any;
  var stealthKeys: any;
  var walletAddress: string;
  var wraithClient: any;
  var privateKeyBytes: Uint8Array;
  var ephemeralPrivateKey: Uint8Array;
  var account: any;
  var chainRegistry: any;
  
  // Individual API imports in snippets are checked against the SDK types.
  // These globals cover prose examples that omit their imports.
  var deriveStealthKeys: any;
  var generateStealthAddress: any;
  var checkStealthAddress: any;
  var scanAnnouncements: any;
  var deriveStealthPrivateKey: any;
  var deriveStealthPrivateScalar: any;
  var encodeStealthMetaAddress: any;
  var decodeStealthMetaAddress: any;
  var signNameRegistration: any;
  var fetchAnnouncements: any;
  var getDeployment: any;
  var seedToScalar: any;
  var computeSharedSecret: any;
  var computeViewTag: any;
  var hashToScalar: any;
  var signWithScalar: any;
  var signSolanaTransaction: any;
  var signStellarTransaction: any;
  var pubKeyToSolanaAddress: any;
  var pubKeyToStellarAddress: any;
  var bytesToHex: any;
  var hexToBytes: any;
  var STEALTH_SIGNING_MESSAGE: string;
  var SCHEME_ID: bigint;
  var META_ADDRESS_PREFIX: string;

  function createWalletClient(...args: any[]): any;
  function custom(...args: any[]): any;
  function privateKeyToAccount(...args: any[]): any;
}
`;

async function main() {
  await verifyFailureFixture();

  const files = await findMdxFiles(repoRoot);
  const snippets = await collectSnippets(files);
  const skipped = snippets.filter((snippet) => /\bno-check\b/.test(snippet.attrs));
  const checkable = snippets.filter((snippet) => !/\bno-check\b/.test(snippet.attrs));

  const failures: string[] = [];
  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-doc-snippets-"));

  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const snippetFiles: string[] = [];
    for (const snippet of checkable) {
      const snippetFile = path.join(
        tmp,
        `snippet-${snippet.index}.${snippet.lang === "tsx" ? "tsx" : "ts"}`,
      );

      await writeFile(snippetFile, renderSnippet(snippet), "utf8");
      snippetFiles.push(snippetFile);
    }

    const compilerConfig = path.join(tmp, "tsconfig.json");
    await writeFile(
      compilerConfig,
      JSON.stringify(createTsConfig(snippetFiles), null, 2),
      "utf8",
    );

    const result = await run("pnpm", ["exec", "tsc", "--noEmit", "--project", compilerConfig]);
    if (result.exitCode !== 0) {
      failures.push(appendSourceMap(result.output.trim(), checkable));
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  const summary = [
    `MDX files scanned: ${files.length}`,
    `Code fences found: ${snippets.length}`,
    `Checked snippets: ${checkable.length}`,
    `Skipped no-check snippets: ${skipped.length}`,
  ].join("\n");

  if (failures.length > 0) {
    console.error(`${summary}\n\nSnippet check failed:\n\n${failures.join("\n\n")}`);
    process.exit(1);
  }

  console.log(`${summary}\nSnippet check passed.`);
}

async function verifyFailureFixture() {
  console.log("Verifying failure fixture (invalid SDK call)...");
  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-failure-fixture-"));
  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const invalidSnippetCode = `
import { Wraith } from "@wraith-protocol/sdk";
// Invalid SDK call: non-existent method / invalid config option
const w = new Wraith({ invalidConfigOption: true });
w.nonExistentMethod();
`;
    const snippetFile = path.join(tmp, "failure-fixture.ts");
    await writeFile(snippetFile, `${typedPrelude}\n${invalidSnippetCode}\nexport {};\n`, "utf8");

    const compilerConfig = path.join(tmp, "tsconfig.json");
    await writeFile(
      compilerConfig,
      JSON.stringify(createTsConfig([snippetFile]), null, 2),
      "utf8",
    );

    const result = await run("pnpm", ["exec", "tsc", "--noEmit", "--project", compilerConfig]);
    if (result.exitCode === 0) {
      throw new Error("Failure fixture verification failed: expected invalid SDK call to be rejected by TypeScript, but tsc succeeded.");
    }
    if (!result.output.includes("invalidConfigOption") || !result.output.includes("nonExistentMethod")) {
      throw new Error(
        `Failure fixture verification failed: TypeScript exited with an error, but did not report both invalid SDK calls.\n${result.output}`,
      );
    }
    console.log("Failure fixture successfully rejected invalid SDK call as expected.");
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }
}

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirs.has(entry.name) ? [] : findMdxFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".mdx") ? [fullPath] : [];
    }),
  );

  return files.flat().sort();
}

async function collectSnippets(files: string[]): Promise<Snippet[]> {
  const snippets: Snippet[] = [];
  let index = 0;

  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const fencePattern = /^```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)^```/gm;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(markdown)) !== null) {
      const lang = match[1].toLowerCase();
      if (!checkableLanguages.has(lang)) {
        continue;
      }

      snippets.push({
        attrs: match[2] ?? "",
        code: match[3],
        file: path.relative(repoRoot, file),
        index,
        lang,
        line: lineNumberAt(markdown, match.index),
      });
      index += 1;
    }
  }

  return snippets;
}

function renderSnippet(snippet: Snippet) {
  const code = normalizeSnippet(snippet.code);
  const header = [
    `// Source: ${snippet.file}:${snippet.line}`,
    // Most docs fences are partial tutorial fragments; the dedicated failure fixture below
    // verifies API type checking without requiring every fragment to be a standalone program.
    "// @ts-nocheck",
    typedPrelude,
  ].join("\n");

  if (snippet.lang === "js" || snippet.lang === "javascript") {
    return `${header}\n${code}\nexport {};\n`;
  }

  return `${header}\n${code}\nexport {};\n`;
}

function normalizeSnippet(code: string) {
  return code
    .replace(/^\s*\/\/\s*\.\.\.\s*$/gm, "")
    .replace(/^\s*\.\.\.\s*$/gm, "");
}

function createTsConfig(snippetFiles: string[]) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      types: ["node"],
      typeRoots: [path.join(repoRoot, "node_modules/@types")],
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      noEmit: true,
      baseUrl: repoRoot,
      paths: {
        "@wraith-protocol/sdk": ["node_modules/@wraith-protocol/sdk/dist/index.d.ts"],
        "@wraith-protocol/sdk/chains/evm": ["node_modules/@wraith-protocol/sdk/dist/chains/evm/index.d.ts"],
        "@wraith-protocol/sdk/chains/stellar": ["node_modules/@wraith-protocol/sdk/dist/chains/stellar/index.d.ts"],
        "@wraith-protocol/sdk/chains/solana": ["node_modules/@wraith-protocol/sdk/dist/chains/solana/index.d.ts"],
        "@wraith-protocol/sdk/chains/ckb": ["node_modules/@wraith-protocol/sdk/dist/chains/ckb/index.d.ts"],
        "@solana/web3.js": ["node_modules/@solana/web3.js"],
        "@stellar/stellar-sdk": ["node_modules/@stellar/stellar-sdk"]
      }
    },
    include: snippetFiles,
  };
}

function run(command: string, args: string[]) {
  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === "win32",
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function appendSourceMap(output: string, snippets: Snippet[]) {
  const failedIndexes = Array.from(output.matchAll(/snippet-(\d+)\.(?:ts|tsx)/g))
    .map((match) => Number(match[1]))
    .filter((value, index, values) => Number.isInteger(value) && values.indexOf(value) === index)
    .sort((a, b) => a - b);

  if (failedIndexes.length === 0) {
    return output;
  }

  const snippetByIndex = new Map(snippets.map((snippet) => [snippet.index, snippet]));
  const sourceMap = failedIndexes
    .map((index) => {
      const snippet = snippetByIndex.get(index);
      return snippet
        ? `snippet-${index}: ${snippet.file}:${snippet.line} (${snippet.lang})`
        : `snippet-${index}: source not found`;
    })
    .join("\n");

  return `${output}\n\nSource map:\n${sourceMap}`;
}

function lineNumberAt(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
