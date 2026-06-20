import { isLand } from "/Users/fkesheh/xcom/src/campaign/landMask.ts";

console.log("Europe (48,14):", isLand(48,14), "expect true");
console.log("Africa (4,22):", isLand(4,22), "expect true");
console.log("(0,-160):", isLand(0,-160), "expect false");
console.log("mid-Atl (40,-40):", isLand(40,-40), "expect false");
console.log("Antarctica (-80,0):", isLand(-80,0), "expect false");
console.log("N.America (40,-100):", isLand(40,-100), "expect true");
console.log("S.America (-15,-60):", isLand(-15,-60), "expect true");
console.log("E.Asia (35,116):", isLand(35,116), "expect true");
console.log("Greenland-ish (72,-40):", isLand(72,-40));
console.log("Antimeridian Russia (66,179):", isLand(66,179));
console.log("Antimeridian Russia (66,-179):", isLand(66,-179));
