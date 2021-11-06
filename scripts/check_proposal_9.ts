import * as dotenv from "dotenv";

import { ethers } from "hardhat";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";

import UniswapV3FactoryAbi from "../abi/UniswapV3Factory.json";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNISWAP_V3_FACTORY_ADDRESS,
} from "./constants";
import { simulateUniswapProposalExecution } from "./utils";
dotenv.config();

const TARGET_PROPOSAL_NUMBER = 9;

async function main() {
  const factoryContract = new ethers.Contract(
    UNISWAP_V3_FACTORY_ADDRESS,
    UniswapV3FactoryAbi,
    ethers.provider
  );
  const governorContract = new ethers.Contract(
    UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
    GovernorBravoDelegateAbi,
    ethers.provider
  );
  await simulateUniswapProposalExecution(TARGET_PROPOSAL_NUMBER);

  // assert proposal is executed
  const proposalInfo = await governorContract.proposals(TARGET_PROPOSAL_NUMBER);
  if (!proposalInfo.executed) {
    throw new Error(`proposal ${TARGET_PROPOSAL_NUMBER} not executed`);
  }
  console.log(`proposal ${TARGET_PROPOSAL_NUMBER} executed ✅`);

  // assert spacing is set correctly
  const tickSpacing = await factoryContract.feeAmountTickSpacing(100);
  if (tickSpacing !== 1) {
    throw new Error(`tick spacing is not correct`);
  }
  console.log(`tick spacing is correct ✅`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
