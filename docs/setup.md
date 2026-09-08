# Setup

## macOS Base Setup

Install Apple Command Line Tools:

```sh
xcode-select --install
```

Install Homebrew if this macOS user has admin access:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install core tools:

```sh
brew install git node pnpm ripgrep
```

If Homebrew is not available, use the user-local Node.js install under:

```sh
~/.local/turnturn-toolchain/node-current
```

Verify:

```sh
git --version
node --version
pnpm --version
rg --version
```

## Repository Setup

After the base toolchain is installed:

```sh
git init
pnpm install
pnpm test
```
