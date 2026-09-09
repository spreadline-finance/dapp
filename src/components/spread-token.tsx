import Image from "next/image";

/** The SPREAD token carries the app's spreading-line identity. */
export function SpreadTokenIcon({ size = 24, className }: { size?: number; className?: string }) {
  return <Image src="/logos/spread-token.svg" width={size} height={size} alt="" aria-hidden="true" className={className} unoptimized/>;
}
