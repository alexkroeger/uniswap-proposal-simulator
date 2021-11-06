# Uniswap Proposal Simulator

This repo can be used to simulate executing Uniswap proposals on a fork of mainnet.

This project uses [hardhat](https://hardhat.org/).

## Setup

1. clone the repository
2. run `npm install`
3. create a `.env` file with a value for `MAINNET_URL`. This must point to an archival node, e.g. Alchemy.

## Usage

You can run a script with the following command:

`npx hardhat run scripts/<script name>`
