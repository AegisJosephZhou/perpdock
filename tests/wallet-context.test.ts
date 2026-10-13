import {describe, it, expect} from 'vitest';
import {validateQuoteContext, isWalletRejection} from '../client/wallets.js';
import type {Quote, Route} from '../shared/types.js';

const source = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const recipient = '0x1111111111111111111111111111111111111111';
const route: Route = {id:'tron-usdt-hypercore', label:'Tron USDT', sourceChain:'Tron', sourceChainId:728126428,
  sourceToken:'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol:'USDT', decimals:6, walletType:'tron', available:true};
const quote = (): Quote => ({id:'test-quote', routeId:route.id, sourceAddress:source, recipient, amount:'100', amountBaseUnits:'100000000',
  expectedReceive:'99', minReceive:'98', expiresAt:new Date(Date.now()+60_000).toISOString(), provider:'Relay', fees:[], warnings:[],
  transaction:{kind:'tron', transaction:{}}, approval:{token:route.sourceToken, spender:'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN', amount:'100000000'}});

describe('wallet signing context safety', () => {
  it('accepts the exact current intent without requesting a wallet or signing', () => {
    expect(() => validateQuoteContext(quote(), route, source, recipient)).not.toThrow();
  });
  it('invalidates expired quotes before another signing operation', () => {
    const q=quote(); q.expiresAt=new Date(Date.now()-1000).toISOString();
    expect(() => validateQuoteContext(q,route,source,recipient)).toThrow(/到期/);
  });
  it('rejects a changed recipient', () => {
    expect(() => validateQuoteContext(quote(),route,source,'0x2222222222222222222222222222222222222222')).toThrow(/不一致/);
  });
  it('treats Tron Base58 addresses as case-sensitive', () => {
    expect(() => validateQuoteContext(quote(),route,source.replace('L','l'),recipient)).toThrow(/不一致/);
  });
  it('rejects altered source token case instead of authorizing another Base58 address', () => {
    const q=quote(); q.approval!.token=route.sourceToken.replace('R','r');
    expect(() => validateQuoteContext(q,route,source,recipient)).toThrow();
  });
  it('rejects an excessive allowance', () => {
    const q=quote(); q.approval!.amount=(2n**256n-1n).toString();
    expect(() => validateQuoteContext(q,route,source,recipient)).toThrow(/额度/);
  });
  it('rejects a transaction for another network kind', () => {
    const q=quote(); q.transaction={kind:'evm',chainId:1,to:recipient,data:'0x',value:'0'};
    expect(() => validateQuoteContext(q,route,source,recipient)).toThrow(/网络/);
  });
  it('recognizes rejection but does not treat a transport timeout as user rejection', () => {
    expect(isWalletRejection({code:4001,message:'User rejected'})).toBe(true);
    expect(isWalletRejection({message:'request timeout'})).toBe(false);
  });
});
