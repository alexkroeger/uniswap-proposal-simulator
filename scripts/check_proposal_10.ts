import * as dotenv from "dotenv";

import { ethers } from "hardhat";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import UniAbi from "../abi/Uni.json";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNI_ADDRESS,
  UNI_TIMELOCK_ADDRESS,
} from "./constants";
import { simulateUniswapProposalExecution } from "./utils";
import { BigNumber } from "ethers";

dotenv.config();

const TARGET_PROPOSAL_NUMBER = 10;

async function main() {
  const governorContract = new ethers.Contract(
    UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
    GovernorBravoDelegateAbi,
    ethers.provider
  );
  const uniContract = new ethers.Contract(UNI_ADDRESS, UniAbi, ethers.provider);
  const proposalResults = await simulateUniswapProposalExecution(
    TARGET_PROPOSAL_NUMBER
  );

  // assert proposal is executed
  const proposalInfo = await governorContract.proposals(TARGET_PROPOSAL_NUMBER);
  if (!proposalInfo.executed) {
    throw new Error(`proposal ${TARGET_PROPOSAL_NUMBER} not executed`);
  }
  console.log(`proposal ${TARGET_PROPOSAL_NUMBER} executed ✅`);

  // assert treasury balance is the same before and after
  const treasuryBalanceBefore: BigNumber = await uniContract.balanceOf(
    UNI_TIMELOCK_ADDRESS,
    { blockTag: proposalResults.forkBlockNumber }
  );
  const treasuryBalanceAfter: BigNumber = await uniContract.balanceOf(
    UNI_TIMELOCK_ADDRESS
  );

  console.log(
    "Treasury Balance Before:",
    ethers.utils.formatEther(treasuryBalanceBefore)
  );
  console.log(
    "Treasury Balance After:",
    ethers.utils.formatEther(treasuryBalanceAfter)
  );

  if (!treasuryBalanceBefore.eq(treasuryBalanceAfter)) {
    throw new Error(`treasury balance changed`);
  }
  console.log(`treasury balance is unaffected ✅`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
