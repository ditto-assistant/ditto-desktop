import type { ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const ThemedRect = withUniwind(Rect);
const ThemedCircle = withUniwind(Circle);

/**
 * The Ditto v2 wordmark, shared with the desktop sidebar. Width derives from
 * the canonical 226 by 76 viewBox.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 226 / 76;
  return (
    <Svg
      accessibilityLabel="Ditto"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 226 76"
    >
      <ThemedRect
        x="0"
        y="19.045"
        width="12.712"
        height="12.712"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedRect
        x="0"
        y="40.572"
        width="12.712"
        height="12.712"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedPath
        d="M17.85 6.49H36.11a30 30 0 0 1 0 60.05H17.85M85.92 34.19v38.96M114.17 10.55v62.48M98.08 27.72h32.45M153.39 10.55v62.48M137.3 27.72h32.45"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeLinecap="butt"
        strokeWidth={13}
      />
      <ThemedRect
        x="120"
        y="60.31"
        width="10.53"
        height="12.72"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedRect
        x="159.22"
        y="60.31"
        width="10.53"
        height="12.72"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedCircle
        cx="199.255"
        cy="49.788"
        r="19.02"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={13.88}
      />
    </Svg>
  );
}
