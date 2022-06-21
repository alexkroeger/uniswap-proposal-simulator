import * as dotenv from "dotenv";

import { ethers } from "hardhat";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import UniAbi from "../abi/Uni.json";
import TimelockAbi from "../abi/Timelock.json";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNI_ADDRESS,
  UNI_TIMELOCK_ADDRESS,
} from "./constants";
import {
  simulateUniswapProposalExecution,
  validateEvent,
  ValidateEventArgs,
} from "./utils";
import { BigNumber, Contract, utils } from "ethers";
import { Log } from "@ethersproject/abstract-provider";

dotenv.config();

const TARGET_PROPOSAL_NUMBER = 22;
const EXPECTED_PAYMENT_AMOUNT_UNI = 500000;
const EXPECTED_PAYMENT_AMOUNT_BASE_UNITS = ethers.utils.parseUnits(
  EXPECTED_PAYMENT_AMOUNT_UNI.toString(),
  18
);
const PROTOCOL_GUILD_VESTING_CONTRACT_ADDRESS =
  "0xF29Ff96aaEa6C9A1fBa851f74737f3c069d4f1a9";

async function main() {
  const governorContract = new ethers.Contract(
    UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
    GovernorBravoDelegateAbi,
    ethers.provider
  );
  const uniContract = new ethers.Contract(UNI_ADDRESS, UniAbi, ethers.provider);
  const timelockContract = new ethers.Contract(
    UNI_TIMELOCK_ADDRESS,
    TimelockAbi,
    ethers.provider
  );

  const proposalResults = await simulateUniswapProposalExecution(
    TARGET_PROPOSAL_NUMBER
  );

  const eta = proposalResults.queueLogs[0].args!.eta.toNumber();

  // assert proposal is executed
  const proposalInfo = await governorContract.proposals(TARGET_PROPOSAL_NUMBER);
  if (!proposalInfo.executed) {
    throw new Error(`proposal ${TARGET_PROPOSAL_NUMBER} not executed`);
  }
  console.log(`proposal ${TARGET_PROPOSAL_NUMBER} executed ✅`);

  // check logs
  checkProposal22Logs(
    proposalResults.executionLogs,
    eta,
    uniContract,
    timelockContract,
    governorContract
  );

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
  if (
    !treasuryBalanceBefore
      .sub(EXPECTED_PAYMENT_AMOUNT_BASE_UNITS)
      .eq(treasuryBalanceAfter)
  ) {
    throw new Error(`treasury balance changed by an unexpected amount`);
  }
  console.log(`treasury balance changed by the expected amount ✅`);
}

function checkProposal22Logs(
  executionLogs: Log[],
  eta: number,
  uniContract: Contract,
  uniTimelockContract: Contract,
  governorContract: Contract
) {
  const validateEventArgsArray: ValidateEventArgs[] = [];

  // first event should be UNI transfer event
  const EXPECTED_TRANSFER_EVENT = {
    from: UNI_TIMELOCK_ADDRESS,
    to: PROTOCOL_GUILD_VESTING_CONTRACT_ADDRESS,
    amount: EXPECTED_PAYMENT_AMOUNT_BASE_UNITS,
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_TRANSFER_EVENT,
    expectedOrigin: UNI_ADDRESS,
    eventName: "Transfer",
    contractInterface: uniContract.interface,
  });

  // second event should be ExecuteTransaction from UNI timelock
  const callDataValues = [
    PROTOCOL_GUILD_VESTING_CONTRACT_ADDRESS,
    EXPECTED_PAYMENT_AMOUNT_BASE_UNITS,
  ];
  const trasferCallDataTypes = ["address", "uint256"];
  const transferCalldata = utils.defaultAbiCoder.encode(
    trasferCallDataTypes,
    callDataValues
  );
  const txHashTypes = ["address", "uint", "string", "bytes", "uint"];
  const txHashValues = [
    UNI_ADDRESS, // target = UNI Contract
    0, // value = 0
    "transfer(address,uint256)",
    transferCalldata, // calldata to transfer UNI
    eta, // eta from queuing
  ];
  const EXPECTED_EXECUTE_TRANSACTION_EVENT: { [key: string]: any } = {
    txHash: utils.keccak256(
      utils.defaultAbiCoder.encode(txHashTypes, txHashValues)
    ),
    target: UNI_ADDRESS,
    value: ethers.BigNumber.from(0),
    signature: "transfer(address,uint256)",
    data: transferCalldata,
    eta: ethers.BigNumber.from(eta),
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_EXECUTE_TRANSACTION_EVENT,
    expectedOrigin: UNI_TIMELOCK_ADDRESS,
    eventName: "ExecuteTransaction",
    contractInterface: uniTimelockContract.interface,
  });

  // third and last event should be ProposalExecuted from UNI governor
  const EXPECTED_PROPOSAL_EXECUTED_EVENT: { [key: string]: any } = {
    id: ethers.BigNumber.from(TARGET_PROPOSAL_NUMBER),
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_PROPOSAL_EXECUTED_EVENT,
    expectedOrigin: UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
    eventName: "ProposalExecuted",
    contractInterface: governorContract.interface,
  });

  let counter = 0;
  for (const validateEventArgs of validateEventArgsArray) {
    counter += 1;
    const rawLog = executionLogs.shift();
    validateEvent(validateEventArgs, rawLog);
    console.log(
      `event #${counter} is expected ${validateEventArgs.eventName} event from ${validateEventArgs.expectedOrigin} ✅`
    );
  }

  if (executionLogs.length !== 0) {
    throw new Error("more events than expected");
  }
  console.log(`no unexpected events ✅`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
