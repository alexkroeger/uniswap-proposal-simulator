import * as dotenv from "dotenv";

import hre, { ethers } from "hardhat";

import { Contract, Event } from "ethers";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNISWAP_VOTERS,
  VITALIK_ADDRESS,
} from "./constants";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import TimelockAbi from "../abi/Timelock.json";
dotenv.config();

export async function advanceBlockHeight(numBlocks: number) {
  const txns = [];
  for (let i = 0; i < numBlocks; i++) {
    txns.push(hre.network.provider.send("evm_mine"));
  }
  await Promise.all(txns);
}

export async function castUniswapYesVote(
  proposalNumber: number,
  voter: string,
  governorContract: Contract
): Promise<void> {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [voter],
  });
  const signer = await ethers.getSigner(voter);
  await governorContract.connect(signer).castVote(proposalNumber, 1);
}

export async function queueUniswapProposal(
  proposalNumber: number,
  governorContract: Contract
): Promise<void> {
  // have vitalik do the honors
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [VITALIK_ADDRESS],
  });
  const signer = await ethers.getSigner(VITALIK_ADDRESS);

  await governorContract.connect(signer).queue(proposalNumber);
}

export async function getUniswapProposalDetails(
  proposalNumber: number,
  governorContract: Contract
): Promise<Event> {
  const proposalBigNumber = ethers.BigNumber.from(proposalNumber);
  const filter = governorContract.filters.ProposalCreated();
  const events = await governorContract.queryFilter(filter);

  for (const event of events) {
    if (event.args!.id.eq(proposalBigNumber)) {
      return event;
    }
  }
  throw new Error("proposal not found");
}

async function executeUniswapProposal(
  proposalNumber: number,
  governorContract: Contract
): Promise<void> {
  // have vitalik do the honors
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [VITALIK_ADDRESS],
  });
  const signer = await ethers.getSigner(VITALIK_ADDRESS);

  await governorContract.connect(signer).execute(proposalNumber);
}

export async function simulateUniswapProposalExecution(
  targetProposalNumber: number
): Promise<{
  forkBlockNumber: number;
}> {
  const governorContract = new ethers.Contract(
    UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
    GovernorBravoDelegateAbi,
    ethers.provider
  );
  const proposalDetails = await getUniswapProposalDetails(
    targetProposalNumber,
    governorContract
  );
  const timelockContract = new ethers.Contract(
    await governorContract.timelock(),
    TimelockAbi,
    ethers.provider
  );

  // fork at the height of the proposal creation
  const forkBlockNumber = proposalDetails.blockNumber;
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: process.env.MAINNET_URL,
          blockNumber: forkBlockNumber,
        },
      },
    ],
  });

  const reviewPeriod = (await governorContract.votingDelay()).toNumber();

  console.log(await ethers.provider.getBlockNumber());

  // advance past review period
  await advanceBlockHeight(reviewPeriod + 1);

  // simulate votes
  for (const voter of UNISWAP_VOTERS) {
    try {
      await castUniswapYesVote(targetProposalNumber, voter, governorContract);
      console.log(`${voter} voted`);
    } catch (e) {
      console.log(`${voter} couldn't vote`);
    }
  }

  // advance past voting period
  const votingPeriod = (await governorContract.votingPeriod()).toNumber();
  await advanceBlockHeight(votingPeriod);

  // queue the proposal
  await queueUniswapProposal(targetProposalNumber, governorContract);

  // advance past timelock period
  const timelockDelay = (await timelockContract.delay()).toNumber();
  await hre.network.provider.request({
    method: "evm_increaseTime",
    params: [timelockDelay + 1],
  });

  // execute the proposal
  await executeUniswapProposal(targetProposalNumber, governorContract);

  return {
    forkBlockNumber,
  };
}
