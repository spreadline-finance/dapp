# Third-party assets and notices

The application license does not grant rights to third-party trademarks, logos,
fonts or dependencies. Their owners retain their respective rights. Displaying a
mark identifies an asset or integration and does not imply endorsement.

## Fonts

The local Editorial web fonts are renamed subsets derived from Linux Libertine G.
Copyright and license terms, including SIL Open Font License 1.0, are preserved in
[`public/fonts/font-license.txt`](public/fonts/font-license.txt). Keep that notice
with redistributed font files.

## Company, fund and token marks

- [`public/logos/stocks/sources.json`](public/logos/stocks/sources.json) records
  source URLs and hashes for bundled company and fund marks.
- [`public/logos/tokens/sources.json`](public/logos/tokens/sources.json) records
  chain-specific token identities and logo sources.
- The older `Apple.svg`, `NVIDIA.svg`, `Robinhood-Chain.png` and `USDG.png` files
  identify their named organizations/assets; their original source URLs are not
  recorded in this checkout.

These source records document provenance, not a license grant. No redistribution
license is recorded for the marks. Check the rights holder's terms before reusing
them; do not represent them as licensed under the code license.

## Protocol marks

[`public/logos/protocols/sources.json`](public/logos/protocols/sources.json)
records the official source and integrity hash of the unmodified Uniswap icon.
Uniswap is a trademark of Uniswap Labs. The mark identifies the protocol used by
the listed pools and swap router; Spreadline is not affiliated with or endorsed
by Uniswap Labs. The code license does not license this mark. See the
[Uniswap Labs trademark guidelines](https://support.uniswap.org/hc/en-us/articles/30934762216973-Uniswap-Labs-Trademark-Guidelines)
for its separate terms.

[`public/logos/protocols/morpho-source.json`](public/logos/protocols/morpho-source.json)
records the source and integrity hash of the original Morpho symbol from the
[official Morpho brand kit](https://brand.morpho.org/). Copyright 2026 MORPHO —
all rights reserved. The symbol identifies the lending protocol and does not
imply affiliation with or endorsement of Spreadline.

## Application assets

`public/og.png` was generated using Image Gen. The PWA icons were derived from
`src/app/icon.svg`. The development prompt and working design documents are not
required to build or run the application and are not distributed here.

## Dependencies

Dependencies and their exact versions are recorded in `package-lock.json`.
Their licenses remain in the installed packages and apply independently.
