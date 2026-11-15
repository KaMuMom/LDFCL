"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { root, packages } = require("../build/workspace.cjs");
const units = [
  ...packages(),
  {
    name: "renderer",
    root: path.join(root, "src"),
    dependencies: { "@ldfcl/contracts": "*" },
  },
];
let files = 0;
const failures = [];
function visit(directory, unit) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) {
      visit(file, unit);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    files++;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.getText(source) === "require" ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        ts.isStringLiteral(node.arguments[0])
      )
        check(node.arguments[0].text);
      ts.forEachChild(node, inspect);
    };
    function check(specifier) {
      const short = path.relative(root, file);
      if (specifier.startsWith(".")) {
        const relative = path.relative(
          unit.root,
          path.resolve(path.dirname(file), specifier),
        );
        if (relative === ".." || relative.startsWith(".." + path.sep))
          failures.push(`${short}: cross-package source import ${specifier}`);
      }
      if (specifier.startsWith("@ldfcl/")) {
        const dependency = specifier.split("/").slice(0, 2).join("/");
        if (dependency !== unit.name && !unit.dependencies?.[dependency])
          failures.push(
            `${short}: undeclared package dependency ${dependency}`,
          );
      }
      if (specifier === "electron" && unit.name !== "@ldfcl/desktop")
        failures.push(`${short}: Electron leaked outside desktop adapter`);
    }
    inspect(source);
    if (/[A-Za-z]:[\\/]+Users[\\/]/i.test(source.text))
      failures.push(`${path.relative(root, file)}: machine-specific user path`);
  }
}
for (const unit of units) visit(unit.root, unit);
if (failures.length) throw Error(failures.join("\n"));
console.log(
  `Architecture checked: ${files} files; isolated contracts, core, CLI, desktop and renderer.`,
);
