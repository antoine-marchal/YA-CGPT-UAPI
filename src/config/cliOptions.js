const args = process.argv.slice(2);

export const cliOptions = {
  model: "gpt-5-instant",
  useprefix: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--model" && i + 1 < args.length) {
    cliOptions.model = args[i + 1];
    i++;
  } else if (arg.startsWith("--model=")) {
    cliOptions.model = arg.split("=")[1];
  } else if (arg === "--useprefix") {
    cliOptions.useprefix = true;
  }
}