import { hashStruct, type Hex, type TypedData } from 'viem';
import { tronHex } from '../chain/tron.js';

// Independent implementation of Relay's published v1 order encoding, checked against
// @relay-protocol/settlement-sdk 0.0.147 in tests. See ORDER-HASH-SOURCES.md.
export type VmType = 'ethereum-vm' | 'tron-vm' | 'hyperliquid-vm';
interface Refund { chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string }
export interface RelayOrder {
  version: string; solverChainId: string; solver: string; salt: string;
  inputs: { payment: {chainId: string; currency: string; amount: string; weight: string}; refunds: Refund[] }[];
  output: {chainId: string; payments: {recipient: string; currency: string; minimumAmount: string; expectedAmount: string}[]; deadline: number; calls: unknown[]; extraData: string};
  fees: unknown[];
}
const field = (name: string, type: string) => ({ name, type });
const types: TypedData = {
  Order: [field('version','string'), field('solverChainId','string'), field('solver','address'), field('salt','uint256'), field('inputs','Input[]'), field('output','Output'), field('fees','Fee[]')],
  Input: [field('payment','InputPayment'), field('refunds','InputRefund[]')],
  InputPayment: [field('chainId','string'), field('currency','bytes'), field('amount','uint256'), field('weight','uint256')],
  InputRefund: [field('chainId','string'), field('recipient','bytes'), field('currency','bytes'), field('minimumAmount','uint256'), field('deadline','uint32'), field('extraData','bytes')],
  Output: [field('chainId','string'), field('payments','OutputPayment[]'), field('deadline','uint32'), field('calls','bytes[]'), field('extraData','bytes')],
  OutputPayment: [field('recipient','bytes'), field('currency','bytes'), field('minimumAmount','uint256'), field('expectedAmount','uint256')],
  Fee: [field('recipientChainId','string'), field('recipient','bytes'), field('currencyChainId','string'), field('currency','bytes'), field('amount','uint256')],
};
function checkedBytes(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Invalid protocol hex bytes');
  return value as Hex;
}
export function getOrderId(order: RelayOrder, vms: Record<string, VmType>): Hex {
  if (order.version !== 'v1' || order.fees.length !== 0 || order.output.calls.length !== 0) throw new Error('Unsupported protocol order');
  const address = (value: string, chain: string): Hex => {
    const vm = vms[chain];
    if (vm === 'tron-vm') return `0x${tronHex(value)}`;
    const hex = checkedBytes(value);
    if (vm === 'ethereum-vm' && hex.length === 42) return hex;
    if (vm === 'hyperliquid-vm' && hex.length >= 4 && hex.length <= 42) return hex;
    throw new Error('Unsupported protocol address');
  };
  const normalized = {
    version: order.version, solverChainId: order.solverChainId, solver: order.solver, salt: order.salt,
    inputs: order.inputs.map(i => ({
      payment: { ...i.payment, currency: address(i.payment.currency, i.payment.chainId) },
      refunds: i.refunds.map(r => ({ ...r, recipient: address(r.recipient,r.chainId), currency: address(r.currency,r.chainId), extraData: checkedBytes(r.extraData) })),
    })),
    output: { ...order.output, payments: order.output.payments.map(p => ({ ...p, recipient: address(p.recipient,order.output.chainId), currency: address(p.currency,order.output.chainId) })), calls: [], extraData: checkedBytes(order.output.extraData) },
    fees: [],
  };
  return hashStruct({ types, primaryType: 'Order', data: normalized });
}
