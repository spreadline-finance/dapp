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

## Application assets

`public/og.png` was generated using Image Gen. The PWA icons were derived from
`src/app/icon.svg`. The development prompt and working design documents are not
required to build or run the application and are not distributed here.

## Dependencies

Dependencies and their exact versions are recorded in `package-lock.json`.
Their licenses remain in the installed packages and apply independently.
