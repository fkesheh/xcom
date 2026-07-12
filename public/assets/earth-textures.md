# Earth texture sources

The geoscape Earth uses locally bundled texture maps so gameplay has no runtime
network dependency.

- `earth-day-2048.jpg`, `earth-normal-2048.jpg`, and
  `earth-specular-2048.jpg`: Three.js example planet textures,
  <https://threejs.org/examples/textures/planets/>.
- `earth-clouds-2048.jpg`: NASA Visible Earth, “Blue Marble: Clouds”,
  <https://visibleearth.nasa.gov/images/57747/blue-marble-clouds>.
- `earth-cloud-alpha-2048.jpg`: game-ready alpha derived from that NASA composite;
  low-luma background is suppressed and the thermal/ice-heavy polar rows are faded
  so Antarctic ground brightness is not rendered as opaque cloud.

NASA describes the cloud layer as a composite of visible-light observations and
thermal infrared imagery over the poles. The Three.js project distributes its
examples under the repository's MIT license.
