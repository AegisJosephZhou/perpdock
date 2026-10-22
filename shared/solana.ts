import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { z } from 'zod';
import type { Route, SolanaInstruction } from './types.js';

export const SOLANA_CHAIN_ID = 792703809;
export const SOLANA_ROUTE_ID = 'solana-usdc-hypercore';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const SOLANA_VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
export const SOLANA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const SOLANA_ROUTE: Route = { id: SOLANA_ROUTE_ID, label: 'Solana USDC → Hyperliquid Perps USDC', sourceChain: 'Solana', sourceChainId: SOLANA_CHAIN_ID, sourceToken: SOLANA_USDC, symbol: 'USDC', decimals: 6, walletType: 'solana', available: true, gasSymbol: 'SOL', assetNote: 'Solana 主网原生 USDC；不支持 USDT、SOL 或其他代币。' };

function canonicalBase58(value: string, bytes: number): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > (bytes === 32 ? 44 : 88)) throw new Error('Invalid Solana base58 value');
  const decoded = bs58.decode(value);
  if (decoded.length !== bytes || bs58.encode(decoded) !== value) throw new Error('Invalid Solana base58 length');
  return value;
}
export const solanaAddress = (value: string): string => canonicalBase58(value, 32);
export const solanaSignature = (value: string): string => canonicalBase58(value, 64);
export const solanaAddressBytes = (value: string): Uint8Array => bs58.decode(solanaAddress(value));
export function solanaPayerAddress(value: string): string {
  const address = solanaAddress(value);
  if (!PublicKey.isOnCurve(solanaAddressBytes(address))) throw new Error('Solana payer must be a wallet public key');
  return address;
}
export function isSolanaAddress(value: string): boolean { try { solanaAddress(value); return true; } catch { return false; } }
export function isSolanaPayerAddress(value: string): boolean { try { solanaPayerAddress(value); return true; } catch { return false; } }

export function deriveSolanaDepositAccounts(sourceAddress: string) {
  const sender = new PublicKey(solanaPayerAddress(sourceAddress));
  const program = new PublicKey(SOLANA_DEPOSITORY);
  const tokenProgram = new PublicKey(SOLANA_TOKEN_PROGRAM);
  const mint = new PublicKey(SOLANA_USDC);
  const associatedProgram = new PublicKey(SOLANA_ASSOCIATED_TOKEN_PROGRAM);
  const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0];
  const vault = pda('vault');
  const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedProgram)[0].toBase58();
  if (vault.toBase58() !== SOLANA_VAULT) throw new Error('Solana vault derivation mismatch');
  return {
    relayDepository: pda('relay_depository').toBase58(), sender: sender.toBase58(), depositor: sender.toBase58(),
    vault: vault.toBase58(), mint: SOLANA_USDC, senderTokenAccount: ata(sender), vaultTokenAccount: ata(vault),
    tokenProgram: SOLANA_TOKEN_PROGRAM, associatedTokenProgram: SOLANA_ASSOCIATED_TOKEN_PROGRAM, systemProgram: SOLANA_SYSTEM_PROGRAM,
  };
}

/** Independent encoding of the reviewed Relay deposit_token ABI; no swaps or approvals. */
export function buildSolanaDepositInstruction(sourceAddress: string, amountBaseUnits: string, protocolOrderId: string): SolanaInstruction {
  if (!/^[1-9][0-9]{0,19}$/.test(amountBaseUnits) || BigInt(amountBaseUnits) > 0xffffffffffffffffn || !/^0x[0-9a-fA-F]{64}$/.test(protocolOrderId)) throw new Error('Invalid Solana deposit amount or order ID');
  const accounts = deriveSolanaDepositAccounts(sourceAddress);
  const data = Buffer.alloc(48);
  Buffer.from('0b9c60da27a3b413', 'hex').copy(data);
  data.writeBigUInt64LE(BigInt(amountBaseUnits), 8);
  Buffer.from(protocolOrderId.slice(2), 'hex').copy(data, 16);
  const key = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
  return { programId: SOLANA_DEPOSITORY, data: data.toString('hex'), keys: [
    key(accounts.relayDepository), key(accounts.sender, true, true), key(accounts.depositor), key(accounts.vault),
    key(accounts.mint), key(accounts.senderTokenAccount, false, true), key(accounts.vaultTokenAccount, false, true),
    key(accounts.tokenProgram), key(accounts.associatedTokenProgram), key(accounts.systemProgram),
  ] };
}

const Address = z.string().min(32).max(44).refine(value => { try { solanaAddress(value); return true; } catch { return false; } }, 'Invalid Solana address');
const Instruction = z.object({ programId: Address, data: z.string().regex(/^[0-9a-fA-F]{96}$/), keys: z.array(z.object({ pubkey: Address, isSigner: z.boolean(), isWritable: z.boolean() }).strict()).length(10) }).strict();

/** Both server and wallet compare every action and privilege, then rebuild reviewed data. */
export function validateSolanaInstructions(rawInstructions: unknown, sourceAddress: string, amountBaseUnits: string, protocolOrderId: string): SolanaInstruction[] {
  const actual = z.array(Instruction).length(1).parse(rawInstructions)[0]!;
  const expected = buildSolanaDepositInstruction(sourceAddress, amountBaseUnits, protocolOrderId);
  if (actual.programId !== expected.programId || actual.data.toLowerCase() !== expected.data || actual.keys.some((key, index) => {
    const allowed = expected.keys[index]!;
    return key.pubkey !== allowed.pubkey || key.isSigner !== allowed.isSigner || key.isWritable !== allowed.isWritable;
  })) throw new Error('Solana deposit instruction does not match the reviewed payer, mint, amount, order and accounts');
  return [expected];
}

/** Lookup tables only compress account keys. The small reviewed deposit is rebuilt without them. */
export function validateSolanaDepositData(rawData: unknown, sourceAddress: string, amountBaseUnits: string, protocolOrderId: string): SolanaInstruction[] {
  const data = z.object({ instructions: z.unknown(), addressLookupTableAddresses: z.array(Address).max(4).optional() }).strict().parse(rawData);
  return validateSolanaInstructions(data.instructions, sourceAddress, amountBaseUnits, protocolOrderId);
}
