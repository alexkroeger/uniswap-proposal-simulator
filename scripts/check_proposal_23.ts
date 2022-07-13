import * as dotenv from "dotenv";

import { ethers } from "hardhat";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import UniAbi from "../abi/Uni.json";
import TimelockAbi from "../abi/Timelock.json";
import CrossChainAccountAbi from "../abi/CrossChainAccountAbi.json";
import L1CrossDomainMessengerAbi from "../abi/L1CrossDomainMessengerAbi.json";
import L2CrossDomainMessengerAbi from "../abi/L2CrossDomainMessengerAbi.json";
import UniswapV3FactoryAbi from "../abi/UniswapV3Factory.json";
import OptimismCanonicalTransactionChainAbi from "../abi/OptimismCanonicalTransactionChainAbi.json";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNI_ADDRESS,
  UNI_TIMELOCK_ADDRESS,
  OVM_CROSS_DOMAIN_MESSENGER_DELEGATOR_ADDRESS,
  UNISWAP_OVM_CROSS_CHAIN_ACCOUNT_ADDRESS,
  UNISWAP_V3_FACTORY_ADDRESS,
  MAGIC_EVENT_VALUE,
  OVM_CANONICAL_TRANSACTION_CHAIN_ADDRESS,
  L2_CROSS_DOMAIN_MESSENGER_ADDRESS,
} from "./constants";
import {
  simulateUniswapProposalExecution,
  validateEvent,
  ValidateEventArgs,
} from "./utils";
import { BigNumber, Contract, utils } from "ethers";
import { Log } from "@ethersproject/abstract-provider";

dotenv.config();

const TARGET_PROPOSAL_NUMBER = 23;
const TARGET_GAS_LIMIT = 3000000;

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
  const ovmL1MessengerContract = new ethers.Contract(
    OVM_CROSS_DOMAIN_MESSENGER_DELEGATOR_ADDRESS,
    L1CrossDomainMessengerAbi,
    ethers.provider
  );
  const ovmL2MessengerContract = new ethers.Contract(
    L2_CROSS_DOMAIN_MESSENGER_ADDRESS,
    L2CrossDomainMessengerAbi,
    ethers.provider
  );
  const ovmCrossChainAccountContract = new ethers.Contract(
    UNISWAP_OVM_CROSS_CHAIN_ACCOUNT_ADDRESS,
    CrossChainAccountAbi,
    ethers.provider
  );
  const factoryContract = new ethers.Contract(
    UNISWAP_V3_FACTORY_ADDRESS,
    UniswapV3FactoryAbi,
    ethers.provider
  );
  const canonicalTransactionChainContract = new ethers.Contract(
    OVM_CANONICAL_TRANSACTION_CHAIN_ADDRESS,
    OptimismCanonicalTransactionChainAbi,
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
  checkProposal23Logs(
    proposalResults.executionLogs,
    eta,
    timelockContract,
    governorContract,
    ovmL1MessengerContract,
    ovmL2MessengerContract,
    ovmCrossChainAccountContract,
    factoryContract,
    canonicalTransactionChainContract
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
  if (!treasuryBalanceBefore.eq(treasuryBalanceAfter)) {
    throw new Error(`treasury balance changed`);
  }
  console.log(`treasury balance is unaffected ✅`);
}

function checkProposal23Logs(
  executionLogs: Log[],
  eta: number,
  uniTimelockContract: Contract,
  governorContract: Contract,
  ovmL1MessengerContract: Contract,
  ovmL2MessengerContract: Contract,
  ovmCrossChainAccountContract: Contract,
  factoryContract: Contract,
  canonicalTransactionChainContract: Contract
) {
  const validateEventArgsArray: ValidateEventArgs[] = [];

  // 1bp fee switch call data
  const feeSwtichCalldata = factoryContract.interface.encodeFunctionData(
    "enableFeeAmount",
    [100, 1]
  );

  // forward call data
  const forwardCalldata =
    ovmCrossChainAccountContract.interface.encodeFunctionData("forward", [
      UNISWAP_V3_FACTORY_ADDRESS,
      feeSwtichCalldata,
    ]);

  // L1 sendMessage calldata
  const l1SendMessageCalldata =
    ovmL1MessengerContract.interface.encodeFunctionData("sendMessage", [
      UNISWAP_OVM_CROSS_CHAIN_ACCOUNT_ADDRESS,
      forwardCalldata,
      TARGET_GAS_LIMIT,
    ]);

  // L2 relayMessage calldata
  // nonce is derived internally from queue length (uint40 nonce = ICanonicalTransactionChain(ovmCanonicalTransactionChain).getQueueLength();)
  // inputting the resulting value here
  const nonce = 122160;
  const l2RelayMessageCalldata =
    ovmL2MessengerContract.interface.encodeFunctionData("relayMessage", [
      UNISWAP_OVM_CROSS_CHAIN_ACCOUNT_ADDRESS,
      UNI_TIMELOCK_ADDRESS,
      forwardCalldata,
      nonce,
    ]);

  // first event should be TransactionEnqueued event from canonical transaction chain
  // tx origin is set to an "address alias" derived from the actual sender
  // which is 0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1, the L1 OVM Messenger
  const aliasSender = "0x36BDE71C97B33Cc4729cf772aE268934f7AB70B2";
  // uint160 constant offset = uint160(0x1111000000000000000000000000000000001111);
  // function applyL1ToL2Alias(address l1Address) internal pure returns (address l2Address) {
  //     unchecked {
  //         l2Address = address(uint160(l1Address) + offset);
  //     }
  // }
  const EXPECTED_TRANSACTION_ENQUEUED_EVENT = {
    _l1TxOrigin: aliasSender,
    _target: L2_CROSS_DOMAIN_MESSENGER_ADDRESS,
    _gasLimit: ethers.BigNumber.from(TARGET_GAS_LIMIT),
    _data: l2RelayMessageCalldata,
    _queueIndex: MAGIC_EVENT_VALUE,
    _timestamp: MAGIC_EVENT_VALUE,
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_TRANSACTION_ENQUEUED_EVENT,
    expectedOrigin: OVM_CANONICAL_TRANSACTION_CHAIN_ADDRESS,
    eventName: "TransactionEnqueued",
    contractInterface: canonicalTransactionChainContract.interface,
  });

  // second event should be SentMessage event from the L1 Cross Domain Messenger
  const EXPECTED_SENT_MESSAGE_EVENT = {
    target: UNISWAP_OVM_CROSS_CHAIN_ACCOUNT_ADDRESS,
    sender: UNI_TIMELOCK_ADDRESS,
    message: forwardCalldata,
    messageNonce: ethers.BigNumber.from(nonce),
    gasLimit: TARGET_GAS_LIMIT,
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_SENT_MESSAGE_EVENT,
    expectedOrigin: OVM_CROSS_DOMAIN_MESSENGER_DELEGATOR_ADDRESS,
    eventName: "SentMessage",
    contractInterface: ovmL1MessengerContract.interface,
  });

  // third event should be ExecuteTransaction from UNI timelock
  const txHashTypes = ["address", "uint", "string", "bytes", "uint"];
  const txHashValues = [
    OVM_CROSS_DOMAIN_MESSENGER_DELEGATOR_ADDRESS, // target = OVM Cross domain messenger
    0, // value = 0
    "",
    l1SendMessageCalldata, // calldata to send a cross chain message
    eta, // eta from queuing
  ];
  const EXPECTED_EXECUTE_TRANSACTION_EVENT: { [key: string]: any } = {
    txHash: utils.keccak256(
      utils.defaultAbiCoder.encode(txHashTypes, txHashValues)
    ),
    target: OVM_CROSS_DOMAIN_MESSENGER_DELEGATOR_ADDRESS,
    value: ethers.BigNumber.from(0),
    signature: "",
    data: l1SendMessageCalldata,
    eta: ethers.BigNumber.from(eta),
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_EXECUTE_TRANSACTION_EVENT,
    expectedOrigin: UNI_TIMELOCK_ADDRESS,
    eventName: "ExecuteTransaction",
    contractInterface: uniTimelockContract.interface,
  });

  // fourth and last event should be ProposalExecuted from UNI governor
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
