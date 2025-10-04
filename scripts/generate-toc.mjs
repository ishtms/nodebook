import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, "..");
const CONTENT_DIR = join(ROOT_DIR, "src", "content");
const TOC_OUTPUT_DIR = join(ROOT_DIR, "public", "toc");

if (!existsSync(TOC_OUTPUT_DIR)) {
  mkdirSync(TOC_OUTPUT_DIR, { recursive: true });
}

function getAllContentFiles(dir, fileList = []) {
  const files = readdirSync(dir);

  files.forEach((file) => {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      getAllContentFiles(filePath, fileList);
    } else if (file.endsWith(".md") || file.endsWith(".mdx")) {
      if (!file.startsWith("_")) {
        fileList.push(filePath);
      }
    }
  });

  return fileList;
}

function extractTocFromMarkdown(content) {
  const headings = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);

    if (headingMatch) {
      const depth = headingMatch[1].length;
      let value = headingMatch[2].trim();

      value = value.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").replace(/~~/g, "").trim();

      const id = value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      const convertedDepth = depth === 2 ? 5 : depth;

      headings.push({
        depth: convertedDepth,
        value,
        id,
      });
    }
  }

  return headings;
}

function getPagePathFromContentFile(contentFilePath) {
  const relativePath = contentFilePath
    .replace(CONTENT_DIR, "")
    .replace(/\.(md|mdx)$/, "")
    .replace(/^\//, "");

  return relativePath.replace(/\//g, "-");
}

function generateTocFiles() {
  console.log("Scanning for content files in src/content...");

  const contentFiles = getAllContentFiles(CONTENT_DIR);
  let processedCount = 0;
  let failedCount = 0;

  console.log(`Found ${contentFiles.length} content files`);

  contentFiles.forEach((contentFile) => {
    try {
      const content = readFileSync(contentFile, "utf-8");
      const toc = extractTocFromMarkdown(content);

      if (toc.length > 0) {
        const pagePath = getPagePathFromContentFile(contentFile);
        const tocFilePath = join(TOC_OUTPUT_DIR, `${pagePath}.json`);

        writeFileSync(tocFilePath, JSON.stringify(toc, null, 2));
        console.log(`Generated TOC for: ${pagePath} (${toc.length} headings)`);
        processedCount++;
      } else {
        console.log(` No headings found in: ${getPagePathFromContentFile(contentFile)}`);
      }
    } catch (error) {
      console.error(`❌ Failed to process ${contentFile}:`, error.message);
      failedCount++;
    }
  });

  console.log(`Successfully generated: ${processedCount} TOC files`);
  console.log(`❌ Failed: ${failedCount} files`);
  console.log(`Output directory: ${TOC_OUTPUT_DIR}\n`);
}

generateTocFiles();
