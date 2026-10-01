import Svg, { Circle, Path } from 'react-native-svg';

/** Bundled decorative brand asset; the same paths and colors in every theme. */
export function YellowDuck() {
  return (
    <Svg testID="keepory-yellow-duck" width={32} height={32} viewBox="0 0 32 32" accessible={false}>
      <Path fill="#FFD83D" d="M12 17c-4-1-7 1-7 5 0 5 4 8 11 8 8 0 13-5 13-12-3 3-5 3-8 2l-9-3Z" />
      <Path fill="#FFE457" d="M10 18C5 14 7 6 12 5c1-3 4-3 5-1 5 0 8 4 8 8 0 5-4 9-9 9l-6-3Z" />
      <Path fill="#F6C52E" d="M13 23c3 0 6 0 8-3 1 5-4 8-8 6-2-1-2-2 0-3Z" />
      <Path fill="#FF9D27" d="M8 11 2 13c-1 1 0 3 2 3h5c2-1 1-4-1-5Z" />
      <Circle cx={12} cy={10} r={1.35} fill="#322D22" />
      <Circle cx={11.6} cy={9.6} r={0.35} fill="#FFF" />
    </Svg>
  );
}
