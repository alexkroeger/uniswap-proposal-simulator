import * as dotenv from "dotenv";

import hre, { ethers } from "hardhat";

import { Contract, Event, utils } from "ethers";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNISWAP_VOTERS,
  VITALIK_ADDRESS,
} from "./constants";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import TimelockAbi from "../abi/Timelock.json";
import { Log } from "@ethersproject/abstract-provider";
import { isBigNumberish } from "@ethersproject/bignumber/lib/bignumber";
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
  governorContract: Contract,
  timelockContract: Contract
): Promise<{ queueLogs: Event[] }> {
  // have vitalik do the honors
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [VITALIK_ADDRESS],
  });
  const signer = await ethers.getSigner(VITALIK_ADDRESS);

  const queueTx = await governorContract.connect(signer).queue(proposalNumber);

  const queueTransactionFilter = timelockContract.filters.QueueTransaction();
  const queueTransactionEvents = await timelockContract.queryFilter(
    queueTransactionFilter
  );
  const relevantqueueTransactionEvents = queueTransactionEvents.filter(
    (event) => event.transactionHash === queueTx.hash
  );

  return {
    queueLogs: relevantqueueTransactionEvents,
  };
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
): Promise<{
  executionLogs: Log[];
}> {
  // have vitalik do the honors
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [VITALIK_ADDRESS],
  });
  const signer = await ethers.getSigner(VITALIK_ADDRESS);

  const execution = await governorContract
    .connect(signer)
    .execute(proposalNumber);

  return {
    executionLogs: (await ethers.provider.getTransactionReceipt(execution.hash))
      .logs,
  };
}

export async function simulateUniswapProposalExecution(
  targetProposalNumber: number
): Promise<{
  forkBlockNumber: number;
  executionLogs: Log[];
  proposalDetails: Event;
  queueLogs: Event[];
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
  const { queueLogs } = await queueUniswapProposal(
    targetProposalNumber,
    governorContract,
    timelockContract
  );

  // advance past timelock period
  const timelockDelay = (await timelockContract.delay()).toNumber();
  await hre.network.provider.request({
    method: "evm_increaseTime",
    params: [timelockDelay + 1],
  });

  // execute the proposal
  const executionResults = await executeUniswapProposal(
    targetProposalNumber,
    governorContract
  );

  return {
    forkBlockNumber,
    executionLogs: executionResults.executionLogs,
    proposalDetails,
    queueLogs,
  };
}

export interface ValidateEventArgs {
  expectedEvent: { [key: string]: any };
  expectedOrigin: string;
  eventName: string;
  contractInterface: utils.Interface;
}

export function validateEvent(
  validateEventArgs: ValidateEventArgs,
  rawEvent: Log | undefined
) {
  const { expectedEvent, expectedOrigin, eventName, contractInterface } =
    validateEventArgs;
  if (rawEvent === undefined) {
    throw new Error("event does not exist");
  }
  if (rawEvent.address.toLowerCase() !== expectedOrigin.toLowerCase()) {
    throw new Error("event from wrong source");
  }
  const actualDecodedEvent = contractInterface.decodeEventLog(
    eventName,
    rawEvent.data,
    rawEvent.topics
  );
  const actualKeys = Object.keys(actualDecodedEvent).filter((key) =>
    isNaN(Number(key))
  );
  const expectedKeys = Object.keys(expectedEvent);

  if (!arraysEqual(expectedKeys, actualKeys)) {
    throw new Error("keys differ");
  }
  for (const key of expectedKeys) {
    if (!valuesEqual(expectedEvent[key], actualDecodedEvent[key])) {
      throw new Error(`unexpected value for ${key}`);
    }
  }
}

function valuesEqual(expected: any, actual: any) {
  if (actual._isIndexed === true) {
    return utils.keccak256(utils.toUtf8Bytes(expected)) === actual.hash;
  } else if (typeof expected === "string") {
    return expected.toLowerCase() === actual.toLowerCase();
  } else if (isBigNumberish(expected)) {
    return expected.toString() === actual.toString();
  } else {
    return expected === actual;
  }
}

function arraysEqual(a: any[], b: any[]) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
