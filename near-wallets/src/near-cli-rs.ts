import * as nearAPI from "near-api-js";
import { KeyPair } from "near-api-js";
import { SelectorStorageKeyStore } from "./utils/keystore";
import { NearRpc } from "./utils/rpc";

type NetworkId = "mainnet" | "testnet";

type SignInArgs = {
  network: NetworkId;
  accountId: string;
  contractId?: string;
  methodNames?: string[];
  allowance?: string;
  signInWithoutAddKey?: boolean;
};

type SignMessageArgs = {
  network: NetworkId;
  accountId: string;
  message: string;
  nonce?: string;
  recipient?: string;
  state?: string;
};

type SignAndSendTxArgs = {
  network: NetworkId;
  receiverId: string;
  actions: any[];
};

type SignAndSendTxsArgs = {
  network: NetworkId;
  transactions: Array<{
    receiverId: string;
    actions: any[];
  }>;
};

type CliSignedMessage = {
  account_id: string;
  public_key: string;
  signature: string;
  message: string;
};

const DEFAULT_RPC_ENDPOINTS: Record<NetworkId, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
};

const keyStore = new SelectorStorageKeyStore();

const stateByNetwork: Partial<
  Record<
    NetworkId,
    {
      near: nearAPI.Near;
      keyStore: SelectorStorageKeyStore;
    }
  >
> = {
  mainnet: undefined,
  testnet: undefined,
};

async function setupNear(network: NetworkId) {
  if (stateByNetwork[network]) return stateByNetwork[network]!;

  const providers = (window as any).selector?.providers?.[network];
  const hasProviders = providers && providers.length > 0;
  const nodeUrl = hasProviders ? providers[0] : DEFAULT_RPC_ENDPOINTS[network];
  const provider = hasProviders ? new NearRpc(providers) : new NearRpc([DEFAULT_RPC_ENDPOINTS[network]]);

  const near = await nearAPI.connect({
    nodeUrl,
    provider,
    networkId: network,
    keyStore,
    headers: {},
  });

  const state = { near, keyStore };
  stateByNetwork[network] = state;
  return state;
}

async function waitForAccessKey(
  network: NetworkId,
  accountId: string,
  publicKey: string,
  contractId?: string,
  timeoutMs = 60_000,
  intervalMs = 2_000,
) {
  const { near } = await setupNear(network);
  const provider = near.connection.provider;

  const start = Date.now();
  for (; ;) {
    try {
      const result: any = await provider.query({
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });

      if (result && result.permission) {
        if (result.permission === "FullAccess") {
          return;
        }

        const fc = result.permission.FunctionCall;
        if (!fc) return;

        if (!contractId || fc.receiver_id === contractId) {
          return;
        }
      }
    } catch (e: any) {
      // view_access_key will throw if key is missing – ignore, keep polling
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for access key to appear on-chain");
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function requireCliApproval(title: string, command: string): Promise<void> {
  alert(`${title}\n\nRun this command in your terminal:\n\n${command}\n\nPress OK after you run it.`);
}

async function askForCliSignedMessageJson(): Promise<CliSignedMessage> {
  const raw = prompt(
    "Paste JSON output from `near message sign` command here.\n\n" +
    "Example:\n" +
    `{"account_id":"frolik.testnet","public_key":"ed25519:...","signature":"ed25519:...","message":"..."}`,
  );
  if (!raw) throw new Error("User cancelled paste of signed message");

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Failed to parse JSON from CLI output");
  }

  if (!parsed.account_id || !parsed.public_key || !parsed.signature || !parsed.message) {
    throw new Error("CLI output missing required fields");
  }

  return parsed as CliSignedMessage;
}

function buildAddKeyCommand(args: SignInArgs & { publicKey: string }): string {
  const parts = ["near", "account", "add-key", args.accountId, args.publicKey];

  if (args.contractId) {
    parts.push("--contract-id", args.contractId);
  }
  if (args.methodNames && args.methodNames.length > 0) {
    parts.push("--method-names", args.methodNames.join(","));
  }
  if (args.allowance) {
    parts.push("--allowance", args.allowance);
  }
  parts.push("--network-config", args.network);

  return parts.join(" ");
}

function buildMessageSignCommand(args: SignMessageArgs): { command: string; payload: string } {
  const payload = JSON.stringify({
    account_id: args.accountId,
    message: args.message,
    nonce: args.nonce,
    recipient: args.recipient,
    state: args.state,
  });

  const command = [
    "near",
    "message",
    "sign",
    "--network-config",
    args.network,
    "--account-id",
    args.accountId,
    "--message",
    `'${payload.replace(/'/g, "\\'")}'`,
  ].join(" ");

  return { command, payload };
}

const NearCliWallet = async () => {
  const selectedAccountByNetwork: Partial<Record<NetworkId, string>> = {};

  async function getSelectedAccount(network: NetworkId): Promise<string | null> {
    const fromMem = selectedAccountByNetwork[network];
    if (fromMem) return fromMem;

    const storage = (window as any).selector?.storage;
    if (storage) {
      const stored = await storage.get(`near-cli:selected:${network}`);
      if (!stored) return null;
      selectedAccountByNetwork[network] = stored;
      return stored;
    }

    const stored = window.localStorage.getItem(`near-cli:selected:${network}`);
    if (!stored) return null;
    selectedAccountByNetwork[network] = stored;
    return stored;
  }

  async function setSelectedAccount(network: NetworkId, accountId: string) {
    selectedAccountByNetwork[network] = accountId;
    const storage = (window as any).selector?.storage;
    if (storage) {
      await storage.set(`near-cli:selected:${network}`, accountId);
    } else {
      window.localStorage.setItem(`near-cli:selected:${network}`, accountId);
    }
  }

  async function clearSelectedAccount(network: NetworkId) {
    delete selectedAccountByNetwork[network];
    const storage = (window as any).selector?.storage;
    if (storage) {
      await storage.remove(`near-cli:selected:${network}`);
    } else {
      window.localStorage.removeItem(`near-cli:selected:${network}`);
    }
  }

  const getAccounts = async (network: NetworkId) => {
    const accountId = await getSelectedAccount(network);
    if (!accountId) return [];

    const { keyStore } = await setupNear(network);
    const keyPair = await keyStore.getKey(network, accountId);
    const publicKey = keyPair ? keyPair.getPublicKey().toString() : "";

    return [{ accountId, publicKey }];
  };

  return {
    // ---------- Session management ----------

    async signIn({ network, accountId, contractId, methodNames, allowance, signInWithoutAddKey }: any) {
      const args: SignInArgs = { network, accountId, contractId, methodNames, allowance, signInWithoutAddKey };

      if (!args.accountId) {
        throw new Error("near-cli wallet requires accountId passed into signIn args");
      }

      // Flow 1: pure message signing (no key added)
      if (args.signInWithoutAddKey || !args.contractId) {
        const message = `Sign in to ${window.location.origin} as ${args.accountId}`;
        await this.signMessage({
          network: args.network,
          accountId: args.accountId,
          message,
        } as SignMessageArgs);

        await setSelectedAccount(args.network, args.accountId);
        return getAccounts(args.network);
      }

      // Flow 2: add limited access key via CLI
      const appKeyPair = KeyPair.fromRandom("ed25519");
      const publicKey = appKeyPair.getPublicKey().toString();

      const addKeyCmd = buildAddKeyCommand({ ...args, publicKey });
      await requireCliApproval("Add a limited access key via NEAR CLI", addKeyCmd);

      await waitForAccessKey(args.network, args.accountId, publicKey, args.contractId);

      const { keyStore } = await setupNear(args.network);
      await keyStore.setKey(args.network, args.accountId, appKeyPair);

      await setSelectedAccount(args.network, args.accountId);

      return [{ accountId: args.accountId, publicKey }];
    },

    async signOut({ network }: { network: NetworkId }) {
      const accountId = await getSelectedAccount(network);
      if (!accountId) return;

      const { keyStore } = await setupNear(network);
      await keyStore.removeKey(network, accountId);
      await clearSelectedAccount(network);
    },

    async getAccounts({ network }: { network: NetworkId }) {
      return getAccounts(network);
    },

    // ---------- Message signing ----------

    async signMessage({ network, accountId, message, nonce, recipient, state }: any) {
      const args: SignMessageArgs = { network, accountId, message, nonce, recipient, state };

      const { command } = buildMessageSignCommand(args);
      await requireCliApproval("Sign message via NEAR CLI", command);

      const signed = await askForCliSignedMessageJson();

      if (signed.account_id !== args.accountId) {
        throw new Error("Signed account_id does not match requested accountId");
      }

      return {
        accountId: signed.account_id,
        publicKey: signed.public_key,
        signature: signed.signature,
        message: signed.message,
      };
    },

    async verifyOwner({ network, message, accountId }: { network: NetworkId; message: string; accountId: string }) {
      return this.signMessage({ network, accountId, message });
    },

    // ---------- Transactions ----------

    async signAndSendTransaction({ network, receiverId, actions }: any) {
      const args: SignAndSendTxArgs = { network, receiverId, actions };

      const accountId = await getSelectedAccount(args.network);
      if (!accountId) {
        throw new Error("Not signed in with near-cli wallet");
      }

      const { near } = await setupNear(args.network);
      const account = await near.account(accountId);

      // If the near-api-js version exposes this direct helper, prefer it
      const maybeDirect = (account as any)["signAndSendTransaction_direct"];
      if (typeof maybeDirect === "function") {
        const result = await maybeDirect.call(account, {
          receiverId: args.receiverId,
          actions: args.actions,
        });
        if (result) return result;
      }

      return account.signAndSendTransaction({
        receiverId: args.receiverId,
        actions: args.actions,
      } as any);
    },

    async signAndSendTransactions({ network, transactions }: any) {
      const args: SignAndSendTxsArgs = { network, transactions };

      const results = [];
      for (const tx of args.transactions) {
        results.push(
          await this.signAndSendTransaction({
            network: args.network,
            receiverId: tx.receiverId,
            actions: tx.actions,
          }),
        );
      }
      return results;
    },

    // ---------- Unsupported methods to keep interface parity with MyNearWallet ----------

    async createSignedTransaction() {
      throw new Error(`Method not supported by NearCliWallet`);
    },

    async signTransaction() {
      throw new Error(`Method not supported by NearCliWallet`);
    },

    async getPublicKey() {
      throw new Error(`Method not directly supported by NearCliWallet; use getAccounts() instead`);
    },

    async signNep413Message() {
      throw new Error(`Method not supported by NearCliWallet`);
    },

    async signDelegateAction() {
      throw new Error(`Method not supported by NearCliWallet`);
    },
  };
};

NearCliWallet().then((wallet) => {
  (window as any).selector.ready(wallet);
});
