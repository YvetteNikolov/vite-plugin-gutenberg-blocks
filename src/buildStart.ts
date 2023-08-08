import { generateFileHash, generatePhpAssetFile, extractFilenameWithoutExtension } from "./utils";
import type { EmittedAsset } from "./generateBundle";
import { build as esBuild } from "esbuild";
import { resolve } from "node:path";
import type { WordpressBlockJson } from "./transform";

const normaliseArray = (source) => (Array.isArray(source) ? source : [source]);

export async function sideload(blockJson: WordpressBlockJson, outputDirectory: string) {
	// Load the block.json options for "script" (frontend/backend) and "viewScript" (frontend)
	const viewScript = blockJson?.viewScript ?? [];
	const standardScript = blockJson?.script ?? [];
	// Normalise into array
	const standardScripts = normaliseArray(standardScript);
	const viewScripts = normaliseArray(viewScript);

	// Combine arrays into array of files
	const concatScripts = viewScripts
		.concat(standardScripts)
		.filter((script) => script.startsWith("file"))
		.map((script) => {
			return script.replace("file:./", "");
		});

	for (const script of concatScripts) {
		const scriptPath = resolve(`${process.env.PWD}/src/${script}`);
		// Vite won't track this file for watching, so we'll add a manual watcher
		this.addWatchFile("./src/" + script);
		let imports = [];
		// Build the script as a sideloaded file that isn't injected into the main bundle
		const result = await esBuild({
			entryPoints: [scriptPath],
			outfile: outputDirectory + "/" + script,
			platform: "browser",
			bundle: true,
			write: false,
			plugins: [
				{
					name: "alias-wordpress",
					setup(build) {
						// Intercept @wordpress/* paths
						build.onResolve({ filter: /^@wordpress\// }, (args) => {
							return {
								path: args.path,
								namespace: "wordpress-alias",
							};
						});

						// Generate a shim for @wordpress/* imports
						build.onLoad({ filter: /.*/, namespace: "wordpress-alias" }, (args) => {
							const moduleName = args.path.split("/")[1];
							imports.push("wp-" + moduleName);
							return {
								contents: `
                const wpModule = window.wp.${moduleName};
                for (const key in wpModule) {
                  if (Object.prototype.hasOwnProperty.call(wpModule, key)) {
                    exports[key] = wpModule[key];
                  }
                }
              `,
								loader: "js",
							};
						});
					},
				},
			],
		});

		result.outputFiles.forEach((file) => {
			const hash = generateFileHash(file.text);
			const filename = extractFilenameWithoutExtension(script);
			this.emitFile({
				type: "asset",
				fileName: filename + ".asset.php",
				source: generatePhpAssetFile(imports, hash),
			} satisfies EmittedAsset);
			this.emitFile({
				type: "asset",
				fileName: script,
				source: file.contents,
			} satisfies EmittedAsset);
		});
	}
}
