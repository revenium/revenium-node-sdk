const fs = require('fs');
const path = require('path');

function fixImportsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  const fixedContent = content.replace(
    /from ['"](\.[^'"]*)['"]/g,
    (match, importPath) => {
      if (path.extname(importPath)) {
        return match;
      }
      return match.replace(importPath, importPath + '.js');
    }
  );

  const finalContent = fixedContent.replace(
    /import ['"](\.[^'"]*)['"]/g,
    (match, importPath) => {
      if (path.extname(importPath)) {
        return match;
      }
      return match.replace(importPath, importPath + '.js');
    }
  );

  if (finalContent !== content) {
    fs.writeFileSync(filePath, finalContent);
    console.log(`Fixed imports in: ${filePath}`);
  }
}

function fixImportsInDirectory(dirPath) {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      fixImportsInDirectory(fullPath);
    } else if (file.endsWith('.js')) {
      fixImportsInFile(fullPath);
    }
  }
}

function writeModuleTypeManifest(dirPath) {
  const manifestPath = path.join(dirPath, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ type: 'module' }, null, 2) + '\n');
  console.log(`Wrote module type manifest: ${manifestPath}`);
}

const esmDir = path.join(__dirname, '..', 'dist', 'esm');
if (fs.existsSync(esmDir)) {
  console.log('Fixing ESM imports...');
  fixImportsInDirectory(esmDir);
  writeModuleTypeManifest(esmDir);
  console.log('ESM imports fixed!');
} else {
  console.log('ESM directory not found');
}
