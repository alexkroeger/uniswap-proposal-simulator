import * as dotenv from "dotenv";

import { ethers } from "hardhat";
import GovernorBravoDelegateAbi from "../abi/GovernorBravoDelegate.json";
import UniAbi from "../abi/Uni.json";
import TimelockAbi from "../abi/Timelock.json";
import PublicResolverAbi from "../abi/PublicResolver.json";
import ENSRegistryWithFallbackAbi from "../abi/ENSRegistryWithFallback.json";
import {
  UNISWAP_GOVERNORBRAVODELEGATOR_ADDRESS,
  UNI_ADDRESS,
  UNI_TIMELOCK_ADDRESS,
  ENS_PUBLIC_RESOLVER_2_ADDRESS,
  ENS_REGISTRY_WITH_FALLBACK_ADDRESS,
} from "./constants";
import {
  simulateUniswapProposalExecution,
  validateEvent,
  ValidateEventArgs,
} from "./utils";
import { BigNumber, Contract, utils } from "ethers";
import { Log } from "@ethersproject/abstract-provider";

const ENS = require("@ensdomains/ensjs");

dotenv.config();

const TARGET_PROPOSAL_NUMBER = 20;

const OTHER_LICENSES = [
  {
    name: "Voltz",
    entryKey: "Voltz Uni v3 Additional Use Grant",
    expectedText: `
    Voltz Labs Technology Limited (“Voltz”) is granted an additional use grant to allow the Voltz DAO to use the Uniswap V3 Core software code (which is made available to Voltz subject to license available at https://github.com/Uniswap/v3-core/blob/main/LICENSE (the “Uniswap Code”)).  	
    As part of this additional use grant, the Voltz DAO receives a limited worldwide license to use the Uniswap Code for the purposes of:
    creating, deploying and making available aspects of an interest rate swap automated market maker (the “IRS AMM”); 
    to modify and update the IRS AMM over time; and 
    deploy the IRS AMM and portions thereof as smart contracts on blockchain-based applications and protocols.  
    The Voltz DAO is permitted to use subcontractors to do this work.  
    This license is conditional on Voltz and the Voltz DAO complying with the terms of the Business Source License 1.1, made available at https://github.com/Uniswap/v3-core/blob/main/LICENSE.
    `,
  },
];

const LICENSE_GRANTS_SUBDOMAIN = "v3-core-license-grants";
const LICENSE_GRANTS_NAME = "v3-core-license-grants.uniswap.eth";
const ENS_TEXT_ENTRY_KEY = `"Gnosis LTD Uni v3 Additional Use Grant"`;
const EXPECTED_ENS_ENTRY_TEXT = `The GnosisDAO and Gnosis LTD are granted an additional use grant to use the Uniswap V3 Core software code (which is made available to the GnosisDAO and Gnosis LTD subject to license available at https://github.com/Uniswap/v3-core/blob/main/LICENSE (the “Uniswap Code”)). As part of this additional use grant, the GnosisDAO and Gnosis LTD receives license to use the Uniswap Code for the purposes of a full deployment of the Uniswap Protocol v3 onto the Gnosis Chain blockchain. The GnosisDAO and Gnosis LTD are permitted to use subcontractors to do this work.  This license is conditional on the GnosisDAO and Gnosis LTD complying with the terms of the Business Source License 1.1, made available at https://github.com/Uniswap/v3-core/blob/main/LICENSE.`;

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
  const publicResolverContract = new ethers.Contract(
    ENS_PUBLIC_RESOLVER_2_ADDRESS,
    PublicResolverAbi,
    ethers.provider
  );
  const ensRegistryContract = new ethers.Contract(
    ENS_REGISTRY_WITH_FALLBACK_ADDRESS,
    ENSRegistryWithFallbackAbi,
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
  checkProposal20Logs(
    proposalResults.executionLogs,
    eta,
    ensRegistryContract,
    timelockContract,
    publicResolverContract,
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
  if (!treasuryBalanceBefore.eq(treasuryBalanceAfter)) {
    throw new Error(`treasury balance changed`);
  }
  console.log(`treasury balance is unaffected ✅`);

  const licenceNamehash = ENS.namehash(LICENSE_GRANTS_NAME);
  const licenseNamehashOwner = await ensRegistryContract.owner(licenceNamehash);
  if (!(licenseNamehashOwner.toLowerCase() === UNI_TIMELOCK_ADDRESS)) {
    throw new Error(`Uniswap timelock does not own the license domain`);
  }
  console.log(`license domain owned by Uniswap timelock ✅`);
  const text = await publicResolverContract.text(
    licenceNamehash,
    ENS_TEXT_ENTRY_KEY
  );
  if (!(text === EXPECTED_ENS_ENTRY_TEXT)) {
    console.log(text);
    throw new Error(`The wrong text was uploaded`);
  }
  console.log(`the correct text was uploaded to the ENS Resolver ✅`);

  for (const license of OTHER_LICENSES) {
    const text = await publicResolverContract.text(
      licenceNamehash,
      license.entryKey
    );
    if (!(text === license.expectedText)) {
      console.log(text);
      throw new Error(`${license.name} not resolving correctly`);
    }
    console.log(`${license.name} resolving correctly ✅`);
  }
}

function checkProposal20Logs(
  executionLogs: Log[],
  eta: number,
  ensRegistryContract: Contract,
  uniTimelockContract: Contract,
  publicResolverContract: Contract,
  governorContract: Contract
) {
  const UNISWAP_NAME_NODE = ENS.namehash("uniswap.eth");
  const LICENSE_GRANTS_LABEL = utils.keccak256(
    utils.toUtf8Bytes(LICENSE_GRANTS_SUBDOMAIN)
  );
  const validateEventArgsArray: ValidateEventArgs[] = [];
  const LICENSE_GRANTS_NAME_NODE = ENS.namehash(LICENSE_GRANTS_NAME);

  // first event should be NewOwner for subdomain
  const EXPECTED_NEWOWNER_EVENT = {
    node: UNISWAP_NAME_NODE,
    label: LICENSE_GRANTS_LABEL,
    owner: UNI_TIMELOCK_ADDRESS,
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_NEWOWNER_EVENT,
    expectedOrigin: ENS_REGISTRY_WITH_FALLBACK_ADDRESS,
    eventName: "NewOwner",
    contractInterface: ensRegistryContract.interface,
  });

  // second event should be ExecuteTransaction from UNI timelock
  // encode
  const callDataValues = [
    UNISWAP_NAME_NODE,
    LICENSE_GRANTS_LABEL,
    UNI_TIMELOCK_ADDRESS,
    ENS_PUBLIC_RESOLVER_2_ADDRESS,
    0, // no cache time
  ];
  const setSubnodeRecordCallDataTypes = [
    "bytes32",
    "bytes32",
    "address",
    "address",
    "uint64",
  ];
  const setSubnodeRecordCalldata = utils.defaultAbiCoder.encode(
    setSubnodeRecordCallDataTypes,
    callDataValues
  );
  const txHashTypes = ["address", "uint", "string", "bytes", "uint"];
  const txHashValues = [
    ENS_REGISTRY_WITH_FALLBACK_ADDRESS, // target = ENS registry
    0, // value = 0
    "setSubnodeRecord(bytes32,bytes32,address,address,uint64)",
    setSubnodeRecordCalldata, // calldata to call ENS registry
    eta, // eta from queuing
  ];
  const EXPECTED_EXECUTE_TRANSACTION_EVENT: { [key: string]: any } = {
    txHash: utils.keccak256(
      utils.defaultAbiCoder.encode(txHashTypes, txHashValues)
    ),
    target: ENS_REGISTRY_WITH_FALLBACK_ADDRESS,
    value: ethers.BigNumber.from(0),
    signature: "setSubnodeRecord(bytes32,bytes32,address,address,uint64)",
    data: setSubnodeRecordCalldata,
    eta: ethers.BigNumber.from(eta),
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_EXECUTE_TRANSACTION_EVENT,
    expectedOrigin: UNI_TIMELOCK_ADDRESS,
    eventName: "ExecuteTransaction",
    contractInterface: uniTimelockContract.interface,
  });

  // third event should be TextChanged from the PublicResolver
  const EXPECTED_TEXTCHANGED_EVENT = {
    node: LICENSE_GRANTS_NAME_NODE,
    indexedKey: ENS_TEXT_ENTRY_KEY,
    key: ENS_TEXT_ENTRY_KEY,
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_TEXTCHANGED_EVENT,
    expectedOrigin: ENS_PUBLIC_RESOLVER_2_ADDRESS,
    eventName: "TextChanged",
    contractInterface: publicResolverContract.interface,
  });

  // fourth event should be ExecuteTransaction from UNI timelock
  const setTextCallDataValues = [
    LICENSE_GRANTS_NAME_NODE,
    ENS_TEXT_ENTRY_KEY,
    EXPECTED_ENS_ENTRY_TEXT,
  ];
  const setTextCallDataTypes = ["bytes32", "string", "string"];
  const setTextCallData = utils.defaultAbiCoder.encode(
    setTextCallDataTypes,
    setTextCallDataValues
  );
  const setTextTxHashValues = [
    ENS_PUBLIC_RESOLVER_2_ADDRESS, // target = resolver
    0, // value = 0
    "setText(bytes32,string,string)",
    setTextCallData, // calldata to call ENS registry
    eta, // eta from queuing
  ];
  const EXPECTED_SET_TEXT_EXECUTE_TRANSACTION_EVENT: { [key: string]: any } = {
    txHash: utils.keccak256(
      utils.defaultAbiCoder.encode(txHashTypes, setTextTxHashValues)
    ),
    target: ENS_PUBLIC_RESOLVER_2_ADDRESS,
    value: ethers.BigNumber.from(0),
    signature: "setText(bytes32,string,string)",
    data: setTextCallData,
    eta: ethers.BigNumber.from(eta),
  };
  validateEventArgsArray.push({
    expectedEvent: EXPECTED_SET_TEXT_EXECUTE_TRANSACTION_EVENT,
    expectedOrigin: UNI_TIMELOCK_ADDRESS,
    eventName: "ExecuteTransaction",
    contractInterface: uniTimelockContract.interface,
  });

  // fifth and last event should be ProposalExecuted from UNI governor
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
