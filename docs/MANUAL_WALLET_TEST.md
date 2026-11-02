# Manual wallet verification (about 10 minutes)

Automated tests use a fake wallet, so real extension popups and real signing must be checked by hand.
Use a small amount of USDC you can afford to lose (for example 0.01 USDC to a second address you control).
The app is configured for Arc Mainnet (chain 5042), so this is a real transaction.

1. **Connect.** Open the preview. The connect screen shows MetaMask, WalletConnect and "Show all wallets".
   Click MetaMask. If several wallet extensions are installed and a picker popup appears, choose MetaMask.
   Expect: your address (short form) in the header and "Connected" in the status pill.
2. **Account switching.** In MetaMask switch to another account. Expect the header address to change within a
   second on every page (Dashboard, Send, History).
3. **Network switching.** Switch MetaMask to another network. Expect Send/Swap to show "runs on Arc mainnet" with a
   Switch button. Switch back to Arc (the app adds the network if MetaMask lacks it). Expect the form to return.
4. **Send.** Send 0.01 USDC to your second address. Expect, in order:
   - "Review transfer" shows the amount, recipient and a network fee estimate.
   - After "Confirm and sign" the MetaMask popup opens within about a second, and the app shows "Confirm in your wallet".
   - After approving: Wallet confirmed, Submitted, Pending, then Confirmed with a block number (normally 1 to 3 seconds).
   - Click the explorer link and check that the same hash is there and succeeded.
5. **Double click.** On the review screen click "Confirm and sign" twice quickly. Expect exactly one MetaMask popup.
6. **Reject.** Send again and press Reject in MetaMask. Expect "cancelled", the form usable again, and no Pending item in History.
7. **Disconnect.** Disconnect from the wallet menu. Expect every page to return to the connect prompt and no address shown.
8. **WalletConnect (optional).** Set `VITE_WALLETCONNECT_PROJECT_ID`, add the origin shown on the connect screen to the
   allowed domains of your Reown project, restart, then connect with a mobile wallet via "Show all wallets".

Report anything that differs. Useful details: the browser, the wallet extensions installed, and the last lines of
the browser console.

## Timing report (for slow popups or slow confirmation)

After a Send, the green "confirmed" card shows three numbers: `Checks` (the app's gas estimate and safety checks before the
wallet opens), `wallet` (from the popup opening until MetaMask returned the hash, including your own reading and
clicking time) and `confirmed ... after submission` (hash to receipt). The same line is printed in the browser console as
`[FLUXORA timing] ...`. If the popup was slow, the console may also show `[FLUXORA timing] the wallet took N ms to answer a
ping (it was asleep)`. Please send those lines if a delay remains.

`bun run scripts/measure-tx-latency.ts init` then `run` measures the same phases on Arc Testnet with a throwaway key.
