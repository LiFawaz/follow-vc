
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");

const root = __dirname;
const input = path.join(root, "plugins/vc-follow");
const output = path.join(root, "dist/vc-follow");

fs.mkdirSync(output, { recursive: true });

const sources = {
    "./index": "src/index.ts",
    "./Settings": "src/Settings.tsx",
};

const compiled = {};

for (const [name, relativePath] of Object.entries(sources)) {
    const file = path.join(input, relativePath);

    const result = ts.transpileModule(
        fs.readFileSync(file, "utf8"),
        {
            fileName: file,
            compilerOptions: {
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.CommonJS,
                jsx: ts.JsxEmit.React,
                isolatedModules: true,
            },
            reportDiagnostics: true,
        }
    );

    if (result.diagnostics?.length) {
        throw new Error(
            ts.formatDiagnosticsWithColorAndContext(
                result.diagnostics,
                {
                    getCurrentDirectory: () => process.cwd(),
                    getCanonicalFileName: name => name,
                    getNewLine: () => "\n",
                }
            )
        );
    }

    compiled[name] = result.outputText;
}

const factories = Object.entries(compiled)
    .map(([name, js]) =>
        `${JSON.stringify(name)}: function(module, exports, require) {\n${js}\n}`
    )
    .join(",\n");

const expression = `(function(vendetta) {
"use strict";

const external = {
    "@vendetta": vendetta,
    "@vendetta/metro": vendetta.metro,
    "@vendetta/metro/common": vendetta.metro.common,
    "@vendetta/commands": vendetta.commands,
    "@vendetta/plugin": vendetta.plugin,
    "@vendetta/patcher": vendetta.patcher,
    "@vendetta/storage": vendetta.storage
};

const factories = { ${factories} };
const cache = Object.create(null);

function require(id) {
    if (Object.prototype.hasOwnProperty.call(external, id)) {
        return external[id];
    }

    if (!Object.prototype.hasOwnProperty.call(factories, id)) {
        throw new Error("Unknown VC Follow module " + id);
    }

    if (cache[id]) return cache[id].exports;

    const module = cache[id] = { exports: {} };

    factories[id](module, module.exports, require);

    return module.exports;
}

return require("./index");
})(vendetta)`;

fs.writeFileSync(
    path.join(output, "index.js"),
    expression + "\n"
);

const manifest = JSON.parse(
    fs.readFileSync(
        path.join(input, "manifest.json"),
        "utf8"
    )
);

manifest.main = "index.js";
manifest.hash = crypto
    .createHash("sha256")
    .update(expression + "\n")
    .digest("hex");

fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
);

console.log(
    "Built dist/vc-follow/index.js and manifest.json; hash",
    manifest.hash
);
