import { pathToFileURL } from 'node:url';

interface CliEntryOptions {
  importMetaUrl: string;
  errorPrefix: string;
  errorExitCode: number;
  main(args: string[]): Promise<void>;
}

export function runCliEntry(options: CliEntryOptions): void {
  const entry = process.argv[1];
  if (!entry || options.importMetaUrl !== pathToFileURL(entry).href) return;
  void options.main(process.argv.slice(2)).catch((error) => {
    console.error(
      `${options.errorPrefix}${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = options.errorExitCode;
  });
}
