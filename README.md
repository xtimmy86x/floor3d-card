# Floor3D Card — Your Home as a Digital Twin

[![hacs_badge](https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge)](https://github.com/custom-components/hacs)
[![GitHub release](https://img.shields.io/github/release/adizanni/floor3d-card.svg?style=for-the-badge)](https://github.com/adizanni/floor3d-card/releases)

Render an interactive 3D model of your home directly in a Lovelace card and bind every object in the scene to a Home Assistant entity — lights, doors, covers, sensors, cameras, and more. Walk through your digital twin and control your home in real time.

---

## Installation

### HACS (recommended)

Search for **floor3d** in **HACS → Frontend** and install. After installing, add the card resource:

```yaml
# configuration.yaml  (or via Settings → Dashboards → Resources)
lovelace:
  resources:
    - url: /hacsfiles/floor3d-card/floor3d-card.js
      type: module
```

### Manual

Download `floor3d-card.js` from the [latest release](https://github.com/adizanni/floor3d-card/releases) and place it in `/config/www/`. Then add the resource:

```yaml
lovelace:
  resources:
    - url: /local/floor3d-card.js
      type: module
```

---

## Preparing Your 3D Model

### Recommended tool — SweetHome3D

[SweetHome3D](http://www.sweethome3d.com/) is free and works well. Model your home, then export via **3D View → Export to OBJ format**. Copy the resulting files (`*.obj`, `*.mtl`, textures) to a subfolder of `/config/www/`.

### GLB format (faster)

Convert the OBJ export to a single binary GLB file for faster loading:

```bash
npm install -g obj2gltf
obj2gltf --checkTransparency -i home.obj -o home.glb
```

Copy only `home.glb` to `/config/www/`. No `.mtl` or texture files needed.

### Tips

- Place the upper-left corner of your floor plan at **0, 0** in the modeling tool for correct camera behaviour.
- Use the [ExportToHASS SweetHome3D plugin](https://github.com/adizanni/ExportToHASS) to preserve object IDs across re-exports.
- To find object IDs: load the card with no entity bindings, then **double-click** any object in edit mode — a popup shows its ID and the current camera position.

---

## Basic Card Configuration

```yaml
type: custom:floor3d-card
name: My Home
path: /local/my_home/          # folder containing the model files
objfile: home.glb              # .glb (recommended) or .obj
# mtlfile: home.mtl            # only needed for .obj format
height: 500                    # card height in pixels (default 400)
backgroundColor: '#aaaaaa'
globalLightPower: '0.8'
header: 'yes'
shadow: 'no'
lock_camera: 'no'
```

### Top-Level Options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | string | **required** | `custom:floor3d-card` |
| `name` | string | `Floor 3d` | Card title |
| `path` | string | **required** | URL path to the folder holding model files |
| `objfile` | string | **required** | Model filename (`.glb` or `.obj`) |
| `mtlfile` | string | — | Material file (`.obj` models only) |
| `height` | number or string | `400` | Card height — pixels (`500`) or any CSS value (`"100vh"`, `"50%"`, `"calc(100vh - 60px)"`) |
| `backgroundColor` | string | `#aaaaaa` | Canvas background: hex color, color name, or `transparent` |
| `backdrop_filter` | string | — | CSS `backdrop-filter` applied to the card (e.g. `"blur(10px) saturate(180%)"`); requires `backgroundColor` to be semi-transparent |
| `globalLightPower` | number/string | `0.5` | Ambient light intensity (0–1) or a numeric sensor entity ID |
| `header` | `yes`/`no` | `yes` | Show the card title bar |
| `shadow` | `yes`/`no` | `no` | Enable light shadows (impacts performance) |
| `extralightmode` | `yes`/`no` | `no` | Limit simultaneous shadow-casting lights to the GPU maximum |
| `lock_camera` | `yes`/`no` | `no` | Disable orbit / zoom / pan |
| `click` | `yes`/`no` | `no` | Enable click events on 3D objects |
| `show_axes` | `yes`/`no` | `no` | Show X/Y/Z axes (useful when setting up spotlights) |
| `sky` | `yes`/`no` | `no` | Render sky, ground, and sun driven by `sun.sun` |
| `north` | object | `{x:0, z:1}` | North direction on the X-Z plane (used with `sky: yes`) |
| `editModeNotifications` | `yes`/`no` | `yes` | Double-click popups in edit mode |
| `selectionMode` | `yes`/`no` | `no` | Select multiple objects (IDs logged to console) |
| `hideLevelsMenu` | `yes`/`no` | `no` | Hide the floor-level selector |
| `initialLevel` | number | — | Level index shown on load |
| `style` | string | — | Inline CSS applied to the `ha-card` element |

---

## Camera

### Setting the default camera position

In edit mode, double-click an empty area of the model to log the current camera YAML to the console and clipboard. Paste into your config:

```yaml
camera_position:
  x: 609.3
  y: 905.5
  z: 376.6
camera_rotate:
  x: -1.093
  y: 0.520
  z: 0.764
camera_target:
  x: 37.4
  y: 18.6
  z: -82.6
```

---

## Zoom Areas

Zoom areas let you jump the camera to a specific room. The card smoothly animates the camera fly-to (750 ms cubic ease-in-out).

```yaml
zoom_areas:
  - name: living_room           # unique name — also the input_select option value
    object_id: LivingRoom_floor # 3D object used to calculate the zoom target
    distance: 600               # camera distance from the target (cm)
    direction:                  # camera approach vector
      x: 0
      y: 1
      z: 0
    level: 0                    # (optional) show this level when zoomed in

  - name: kitchen
    object_id: Kitchen_floor
    distance: 400
```

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | **required** | Unique zoom area identifier |
| `object_id` | string | **required** | 3D object that defines the zoom target |
| `distance` | number | `500` | Camera distance from target in model units |
| `direction` | object | `{x:0,y:1,z:0}` | Camera approach direction vector |
| `level` | number | — | Show this floor level when zoom is active |

### Hiding the zoom selector UI

```yaml
hide_zoom_areas_ui: 'yes'   # hides the bottom-left zoom dropdown
```

### Controlling zoom from Home Assistant (zoom_entity)

Bind zoom to an `input_select` helper so automations and other cards can both **read and set** the current zoom:

```yaml
zoom_entity: input_select.floor3d_zoom
```

**How it works:**
- When the `input_select` state changes → card flies to the matching zoom area.
- When the user clicks a zoom button in the card → the `input_select` is updated.
- Set the state to `reset` to return to the default camera position.

**Setting up the helper** (Settings → Helpers → Add → Dropdown):
- Options: one per zoom area `name`, plus `reset`

**Triggering from a Button card:**
```yaml
type: button
name: Living Room
tap_action:
  action: call-service
  service: input_select.select_option
  data:
    entity_id: input_select.floor3d_zoom
    option: living_room
```

**Automation — zoom to occupied room:**
```yaml
alias: Follow room presence
trigger:
  - platform: state
    entity_id: input_select.anas_room
action:
  - service: input_select.select_option
    data:
      entity_id: input_select.floor3d_zoom
      option: "{{ trigger.to_state.state }}"
```

---

## Entity Bindings

Bind 3D objects to Home Assistant entities via the `entities` list.

```yaml
entities:
  - entity: light.living_room
    type3d: light
    object_id: LivingRoom_ceiling_lamp
    light:
      lumens: 800
      decay: 1
      distance: 300
```

### Common entity fields

| Field | Type | Description |
|---|---|---|
| `entity` | string | HA entity ID (or `<object_group>` reference) |
| `type3d` | string | Binding type — see sections below |
| `object_id` | string | 3D object name in the model |
| `entity_template` | string | JS template: `'[[[ if ($entity > 25) { "hot" } ]]]'` |
| `action` | string | On-click: `more-info`, `overlay`, or `default` |
| `tap_action` | object | Standard Home Assistant tap action (for example `toggle`, `more-info`, `call-service`, or `navigate`) |
| `hold_action` | object | Standard Home Assistant hold action |
| `double_tap_action` | object | Standard Home Assistant double-tap action |

Standard actions work with every `type3d` binding. When an action is omitted, the
binding keeps its existing Floor3D click behavior.

```yaml
entities:
  - entity: input_boolean.living_room
    type3d: room
    object_id: room_10_56
    tap_action:
      action: toggle
    hold_action:
      action: more-info
    double_tap_action:
      action: call-service
      service: script.turn_on
      service_data:
        entity_id: script.turn_on_living_room
```

---

### Light

Illuminates a point in the scene. Tracks brightness, color, and color temperature.

```yaml
- entity: light.kitchen
  type3d: light
  object_id: Kitchen_pendant
  light:
    lumens: 600          # max brightness (0–4000)
    color: '#ffddaa'     # static color (overridden by HA color attrs)
    decay: 1             # light falloff rate (0–2)
    distance: 400        # effect radius in model units
    shadow: 'no'         # override global shadow for this light
    vertical_alignment: top   # top/middle/bottom — avoids lamp blocking itself
    light_target: TV_screen   # makes it a spotlight aimed at this object
```

---

### Hide / Show

Hide or reveal a 3D object based on entity state.

```yaml
- entity: binary_sensor.front_door
  type3d: hide
  object_id: FrontDoor_open_state
  hide:
    state: 'off'         # hide the object when entity state equals this

- entity: binary_sensor.rain
  type3d: show
  object_id: Umbrella
  show:
    state: 'on'          # show the object when entity state equals this
```

---

### Color

Paint a 3D object a different color depending on entity state.

```yaml
- entity: sensor.living_room_temp
  type3d: color
  object_id: Thermometer
  entity_template: '[[[ if ($entity > 25) { "hot" } else { "cool" } ]]]'
  colorcondition:
    - state: hot
      color: '#ff4444'
    - state: cool
      color: '#4444ff'
```

---

### Text

Render entity state as text on a flat plane object (TV screen, picture frame, display).

```yaml
- entity: sensor.living_room_temp
  type3d: text
  object_id: TempDisplay_plane
  text:
    span: 60%
    font: verdana
    textbgcolor: '#000000'
    textfgcolor: '#ffffff'
    attribute: temperature   # optional — show an attribute instead of state
```

---

### Door

Animate a door or window opening and closing.

```yaml
- entity: binary_sensor.front_door
  type3d: door
  object_id: FrontDoor
  door:
    doortype: swing          # swing or slide
    direction: inner         # inner or outer (swing only)
    side: left               # up/down/left/right — hinge side
    degrees: 90              # open angle (swing) or percentage (slide)
    hinge: FrontDoor_hinge   # object_id of the hinge (optional)
    pane: FrontDoor_pane     # object_id of the moving panel (optional)
```

---

### Cover

Animate covers (blinds, roller shutters) based on `current_position` attribute.

```yaml
- entity: cover.living_room_blind
  type3d: cover
  object_id: LivingRoom_blind
  cover:
    doortype: slide
    side: up
    direction: inner
    percentage: 100
```

---

### Rotate

Continuously rotate an object (fans, turbines, etc.).

```yaml
- entity: fan.ceiling_fan
  type3d: rotate
  object_id: CeilingFan_blades
  rotate:
    axis: y
    round_per_second: 2
```

---

### Room

Highlight a room with a translucent parallelepiped and an optional state label.

```yaml
- entity: sensor.living_room_motion
  type3d: room
  object_id: LivingRoom_floor_room
  room:
    elevation: 240
    transparency: 60
    color: '#aaffaa'
    label: 'yes'
    span: 50%
    font: verdana
    textbgcolor: '#00000000'
    textfgcolor: '#ffffff'
  colorcondition:
    - state: 'on'
      color: '#ff0000'
    - state: 'off'
      color: '#00ff00'
```

---

### Gesture

Call a service when a 3D object is double-clicked.

```yaml
- entity: switch.coffee_maker
  type3d: gesture
  object_id: CoffeeMaker
  gesture:
    domain: switch
    service: toggle
```

---

### Camera

Show a camera feed popup when an object is double-clicked.

```yaml
- entity: camera.front_door
  type3d: camera
  object_id: FrontDoor_camera_mount
```

---

## Object Groups

Group multiple objects so they respond to one entity binding. Reference a group with `<group_name>` syntax.

```yaml
object_groups:
  - object_group: LivingRoomLights
    objects:
      - object_id: Lamp_1
      - object_id: Lamp_2
      - object_id: Lamp_3

entities:
  - entity: light.living_room
    type3d: light
    object_id: <LivingRoomLights>
    light:
      lumens: 800
```

---

## Overlay Panel

Show entity name and state in a floating panel when objects are clicked.

```yaml
overlay: 'yes'
click: 'yes'
overlay_bgcolor: 'rgba(0,0,0,0.6)'
overlay_fgcolor: '#ffffff'
overlay_alignment: top-left   # top-left, top-right, bottom-left, bottom-right
overlay_width: '33'           # percentage of card width
overlay_height: '20'          # percentage of card height
overlay_font: verdana
overlay_fontsize: 14px

entities:
  - entity: sensor.living_room_temp
    type3d: color
    object_id: Thermometer
    action: overlay             # clicking shows state in the overlay panel
```

---

## Anchors

Named anchors attach logical positions to 3D objects. Markers, room controls, and animations all reference anchors.

```yaml
anchors:
  - id: living_room_center      # logical name used by markers/controls/animations
    object_id: LivingRoom_floor # any object in the scene
  - id: kitchen_center
    object_id: Kitchen_island
  - id: ac_unit_living
    object_id: AC_unit_living_room
```

---

## Markers

Markers render floating HTML elements above 3D anchors to show where people, pets, or devices are. They animate smoothly between rooms when the entity state changes.

### Marker types

| Type | Description |
|---|---|
| `person` | Round avatar from a `person.*` entity (uses entity picture) |
| `avatar` | Round image from a custom URL |
| `icon` | MDI icon |
| `dot` | Filled circle |
| `badge` | Label badge |

### Example — person marker

```yaml
anchors:
  - id: living_room_center
    object_id: LivingRoom_floor
  - id: kitchen_center
    object_id: Kitchen_floor

markers:
  - id: anas_marker
    entity: input_select.anas_current_room   # state = current room name
    type: person
    person_entity: person.anas               # pulls picture + name
    size: 52
    hide_states:
      - not_home
      - unknown
    rooms:
      living_room: living_room_center        # entity state → anchor id
      kitchen: kitchen_center
      bedroom: bedroom_center
```

### Example — device icon marker

```yaml
markers:
  - id: robot_vacuum
    entity: input_select.vacuum_room
    type: icon
    icon: mdi:robot-vacuum
    color: '#4fc3f7'
    size: 40
    rooms:
      living_room: living_room_center
      kitchen: kitchen_center
    visible_when:
      entity: vacuum.roborock
      state_not: docked
```

### Marker options

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | string | **required** | Unique identifier |
| `entity` | string | **required** | Entity whose state is the current room name |
| `type` | string | **required** | `person`, `avatar`, `icon`, `dot`, or `badge` |
| `person_entity` | string | — | `person.*` entity (for `type: person`) |
| `image` | string | — | Image URL (for `type: avatar`) |
| `icon` | string | — | MDI icon name (for `type: icon`) |
| `color` | string | — | CSS color |
| `size` | number | `48` | Marker size in pixels |
| `rooms` | map | **required** | `room_state_value: anchor_id` mapping |
| `hide_states` | list | — | States that hide the marker |
| `visible_when` | condition | — | Additional visibility condition |
| `action` | string | `more-info` | Click action: `more-info` or `none` |
| `z_offset` | number | `0` | Vertical shift in model units |
| `offset_x` | number | `0` | Screen-space X offset in pixels |
| `offset_y` | number | `0` | Screen-space Y offset in pixels |

---

## Room Controls

Floating icon buttons anchored to 3D positions for quick room-level control.

```yaml
room_controls:
  - id: living_lights_btn
    anchor: living_room_center   # anchor id from the anchors list
    entity: light.living_room
    control_type: toggle
    icon: mdi:lightbulb
    color_on: '#ffdd55'
    color_off: 'rgba(255,255,255,0.3)'
    size: 44
    z_offset: 50

  - id: living_media_btn
    anchor: living_room_center
    entity: media_player.living_room_tv
    control_type: more-info
    icon: mdi:television
    size: 44
    offset_x: 56              # stack horizontally next to first button
```

### Control types

| Type | Description |
|---|---|
| `toggle` | Calls `homeassistant.toggle` on click |
| `more-info` | Opens the more-info dialog |
| `service-call` | Calls a custom `service` with `service_data` |
| `scene-select` | Activates a scene entity |
| `media-toggle` | Plays / pauses a media player |

### Room control options

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | string | **required** | Unique identifier |
| `anchor` | string | **required** | Anchor ID from `anchors` |
| `entity` | string | **required** | HA entity to reflect and control |
| `control_type` | string | **required** | See table above |
| `icon` | string | — | MDI icon name |
| `label` | string | — | Text label |
| `size` | number | `40` | Button size in pixels |
| `color_on` | string | — | CSS color when entity is active |
| `color_off` | string | — | CSS color when entity is inactive |
| `service` | string | — | Service to call (for `service-call` type) |
| `service_data` | map | — | Data passed to the service |
| `visible_when` | condition | — | Visibility condition |
| `z_offset` | number | `0` | Vertical shift in model units |
| `offset_x` | number | `0` | Screen-space X offset in pixels |
| `offset_y` | number | `0` | Screen-space Y offset in pixels |

---

## Room Animations

True 3D particle animations anchored to scene objects — musical notes that jump out of a speaker in 3D space, and airflow streaks that fan out from an AC unit in a configurable direction. Both are rendered inside the THREE.js scene (not as HTML overlays) so they move naturally when you orbit the camera.

### Music notes

`THREE.Sprite` objects float upward from the speaker anchor, each with a smooth fade-in/out and a gentle sinusoidal drift. The animation **only activates when the media player is both playing and has volume > 0** — so a muted or paused player stays silent.

```yaml
animations:
  - id: living_room_music
    type: music_notes
    entity: media_player.living_room_speaker
    anchor: speaker_anchor         # 3D object name in the loaded model
    active_state: playing          # default: 'playing'
    color: 'rgba(255,215,80,0.95)' # note color (default: golden)
    z_offset: 0                    # extra vertical shift in world units
```

**How it looks:** Eight ♪ / ♫ sprites cycle upward one after another with staggered timing. Each note fades in, drifts sideways, and fades out as it rises — giving a continuous stream effect.

### AC airflow

`THREE.LineSegments` streaks fan out in a flat arc from the AC anchor — mimicking the horizontal louver spread of a wall-mounted split unit. Color updates automatically based on `hvac_mode` / `hvac_action`.

```yaml
animations:
  - id: bedroom_ac
    type: ac_flow
    entity: climate.bedroom_ac
    anchor: ac_unit_anchor          # 3D object name in the loaded model
    flow_direction: 'north|down'    # forward + slightly downward (wall unit)
    flow_spread: 110                # total horizontal arc in degrees (default 110)
    color_cool: '#4fc3f7'           # cooling mode color (default: sky blue)
    color_heat: '#ff7043'           # heating mode color (default: orange)
    color_fan:  'rgba(210,210,210,0.85)' # fan-only color (default: light grey)
    z_offset: 0
```

**How it looks:** Twelve streaks are distributed evenly across the fan arc, all starting at the anchor and cycling outward together. The spread is flat (left-right) — not a 3D cone — so it looks like air coming out of a louver rather than a leaf blower. The animation disappears automatically when the AC is `off` or `idle`.

#### Flow direction options

`flow_direction` accepts three formats:

| Format | Example | Description |
|---|---|---|
| Single keyword | `north` | One of the 6 cardinal directions below |
| Compound (pipe) | `north\|down` | Sum of two or more keywords, normalized — ideal for wall ACs |
| Raw vector | `0.7,-0.3,0` | Custom x,y,z normalized direction |

**Keyword reference:**

| Value | Description |
|---|---|
| `down` *(default)* | Blows downward — ceiling cassette units |
| `up` | Blows upward — floor vents, upflow units |
| `north` | Horizontal, toward the model's north |
| `south` | Horizontal, toward south |
| `east` | Horizontal, 90° clockwise from north |
| `west` | Horizontal, 90° counter-clockwise from north |
| `bottom` | Alias for `down` |

The `north`/`south`/`east`/`west` values respect the card-level `north` config so the direction is always correct for your floor plan orientation.

### Animation options

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | string | **required** | Unique identifier |
| `type` | string | **required** | `music_notes` or `ac_flow` |
| `entity` | string | **required** | HA entity driving the animation |
| `anchor` | string | **required** | 3D object name used as the spawn point |
| `active_state` | string | `playing` | State that activates the animation (`music_notes` only) |
| `color` | string | golden | Note color (`music_notes` only) |
| `note_size` | number | `1.0` | Sprite size multiplier — `0.5` = half size, `2.0` = double (`music_notes`) |
| `note_speed` | number | `1.0` | Float speed multiplier — `0.5` = half speed, `2.0` = double (`music_notes`) |
| `flow_direction` | string | `down` | Airflow direction — keyword, compound `north\|down`, or raw `x,y,z` (`ac_flow`) |
| `flow_spread` | number | `110` | Total horizontal fan arc in degrees (`ac_flow`) |
| `color_cool` | string | `#4fc3f7` | Streak color in cooling mode (`ac_flow`) |
| `color_heat` | string | `#ff7043` | Streak color in heating mode (`ac_flow`) |
| `color_fan` | string | grey | Streak color in fan-only mode (`ac_flow`) |
| `z_offset` | number | `0` | Vertical shift of the anchor in world units |
| `visible_when` | condition | — | Additional visibility condition |

---

## Visibility Conditions

`visible_when` can be used on markers, room controls, and animations. It supports simple leaf conditions and compound AND/OR logic.

### Leaf condition

```yaml
visible_when:
  entity: binary_sensor.someone_home
  state: 'on'
```

Available operators: `state`, `state_not`, `state_in`, `state_not_in`.

### Compound condition (AND)

```yaml
visible_when:
  and:
    - entity: input_boolean.show_markers
      state: 'on'
    - entity: person.anas
      state_not: not_home
```

### Compound condition (OR)

```yaml
visible_when:
  or:
    - entity: sensor.mode
      state: home
    - entity: sensor.mode
      state: guest
```

---

## Sky, Sun, Moon & Weather

### Enabling the sky

Set `sky: 'yes'` to activate the atmospheric sky shader (THREE.js Sky). A realistic atmosphere, directional sunlight, and optional ground plane are added to the scene. The sun position is read from the `sun.sun` entity and updates live as it changes throughout the day.

```yaml
sky: 'yes'
north:             # optional — which axis points north in your model
  x: -1
  z: 0
```

> **Tip:** Add a flat transparent slab object in SweetHome3D named `transparent_slab*` to prevent sunlight from shining through the ceiling.

### Sky options

| Option | Type | Default | Description |
|---|---|---|---|
| `sky` | `yes`/`no` | `no` | Enable the atmospheric sky |
| `north` | object | `{x:0, z:1}` | North direction in model space (X-Z plane) — aligns sun/moon with real cardinal directions |
| `sky_distance` | number | `100000` | Radius of the sky dome in world units; reduce for a "closer horizon" feel |
| `sky_background` | `yes`/`no` | `yes` | `no` removes the atmosphere mesh so the background is transparent (sun/moon/weather still work) |
| `ground` | string | warm yellow | Ground plane appearance: `none` removes it, `transparent` keeps it invisible (for shadow reception), or any CSS color (`'#2d4a1e'`) |

### Sun sphere

When `sky: 'yes'`, a visible 3D sun sphere is added to the scene and follows the real solar elevation/azimuth live.

| Option | Type | Default | Description |
|---|---|---|---|
| `sun_distance` | number | auto | Distance of the sun sphere from scene center (world units); defaults to 1.5× bounding-box diagonal |
| `sun_size` | number | `1.0` | Size multiplier for the sun sphere — `< 1` shrinks, `> 1` enlarges |

### Moon with lunar phase

When `sky: 'yes'` and the sun is below the horizon (`sun.sun` state = `below_horizon`), a moon sphere automatically appears at the antipodal position in the sky. Its texture shows the correct lunar phase (waxing/waning crescent, quarter, gibbous, full, new).

| Option | Type | Default | Description |
|---|---|---|---|
| `show_moon` | `yes`/`no` | `yes` | Show/hide the moon sphere at night |
| `moon_distance` | number | auto | Distance of the moon sphere from scene center (world units) |
| `moon_size` | number | `1.0` | Size multiplier for the moon sphere |
| `moon_entity` | string | — | Optional HA moon phase sensor (e.g. `sensor.moon`) whose state is the phase name (`full_moon`, `waxing_crescent`, etc.) — overrides the built-in calculation |

**Supported `moon_entity` state values:** `new_moon`, `waxing_crescent`, `first_quarter`, `waxing_gibbous`, `full_moon`, `waning_gibbous`, `last_quarter`, `waning_crescent`.

### Weather-driven sky & particle effects

Point `weather_entity` at a HA `weather.*` entity to have the sky dynamically adapt to current conditions. Sky turbidity and fog automatically update, and 3D particle systems create rain, snow, hail, wind, or sandstorm effects in the scene.

```yaml
sky: 'yes'
weather_entity: weather.home
weather_precipitation: 'yes'   # set 'no' to disable 3D particles (sky still adapts)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `weather_entity` | string | — | HA weather entity ID |
| `weather_precipitation` | `yes`/`no` | `yes` | Enable 3D particle weather effects |

#### How weather states map to effects

| HA state | Sky change | 3D particle effect |
|---|---|---|
| `sunny` / `clear-night` | Bright blue sky, no fog | — |
| `partlycloudy` | Slightly hazier | — |
| `cloudy` | High turbidity + light fog | — |
| `fog` | Very high turbidity + dense fog | — |
| `rainy` | Hazy + light fog | Rain streaks (900 drops) |
| `lightning-rainy` | Hazy + fog | Rain streaks + lightning flash |
| `pouring` | Very hazy + medium fog | Heavy rain streaks (1500 drops) |
| `snowy` | Hazy + light fog | Snowflakes (800 particles) |
| `snowy-rainy` | Hazy + fog | Snowflakes (800 particles) |
| `hail` | Overcast + fog | Hailstones (500 particles) |
| `lightning` | Overcast + fog | Lightning flash |
| `windy` / `windy-variant` | Clear | Wind streaks (speed-proportional, see below) |
| `sandstorm` / `dust` / `exceptional` | Amber, very dense fog | Sand particles below roofline (800 particles) |

#### Wind streaks (independent of weather state)

Wind streaks appear **automatically whenever `wind_speed > 18 km/h`**, regardless of the overall weather state (e.g., you can have rain + wind at the same time). They are oriented along `wind_bearing` and their speed, count, and opacity scale with wind speed.

| `wind_speed` (km/h) | Effect |
|---|---|
| ≤ 18 | No streaks |
| 19–30 | Light streaks (soft blue-white lines) |
| 30–60 | Moderate to heavy streaks |
| > 60 | Dense, fast-moving streaks |

The `wind_bearing` attribute (meteorological convention — direction **from** which wind blows) automatically rotates the streak direction to match actual wind direction. `north` config is respected.

### Full sky example

```yaml
sky: 'yes'
north:
  x: -1
  z: 0
weather_entity: weather.home
weather_precipitation: 'yes'
show_moon: 'yes'
moon_entity: sensor.moon          # optional
sun_distance: 3000
sun_size: 1.2
moon_distance: 3000
moon_size: 1.0
sky_distance: 100000
ground: '#2d4a1e'                 # dark green grass
```

### Backdrop blur / glass card effect

Apply a CSS `backdrop-filter` to create a frosted-glass look. Use a semi-transparent `backgroundColor` so the blurred content behind the card is visible.

```yaml
backgroundColor: 'rgba(0,0,0,0.35)'
backdrop_filter: 'blur(12px) saturate(180%)'
```

---

## Full Configuration Example

```yaml
type: custom:floor3d-card
name: Home
path: /local/my_home/
objfile: home.glb
height: 550                        # or: height: "100vh"
backgroundColor: '#cccccc'
globalLightPower: '0.7'
header: 'yes'
shadow: 'no'
lock_camera: 'no'
hide_zoom_areas_ui: 'no'
zoom_entity: input_select.floor3d_zoom

# Sky & weather
sky: 'yes'
north:
  x: -1
  z: 0
weather_entity: weather.home
weather_precipitation: 'yes'
show_moon: 'yes'
sun_distance: 3000
sun_size: 1.2
moon_distance: 3000
ground: '#2d4a1e'

camera_position:
  x: 609.3
  y: 905.5
  z: 376.6
camera_target:
  x: 37.4
  y: 18.6
  z: -82.6

zoom_areas:
  - name: living_room
    object_id: LivingRoom_floor
    distance: 500
  - name: kitchen
    object_id: Kitchen_floor
    distance: 400

anchors:
  - id: living_room_center
    object_id: LivingRoom_floor
  - id: kitchen_center
    object_id: Kitchen_floor
  - id: ac_unit_living
    object_id: AC_LivingRoom

markers:
  - id: anas
    entity: input_select.anas_room
    type: person
    person_entity: person.anas
    size: 52
    hide_states: [not_home, unknown]
    rooms:
      living_room: living_room_center
      kitchen: kitchen_center

room_controls:
  - id: living_lights
    anchor: living_room_center
    entity: light.living_room
    control_type: toggle
    icon: mdi:lightbulb
    color_on: '#ffdd55'
    color_off: 'rgba(255,255,255,0.25)'
    size: 44
    z_offset: 60

animations:
  - id: living_music
    type: music_notes
    entity: media_player.living_room
    anchor: living_room_center
    active_state: playing
    z_offset: 90
  - id: living_ac
    type: ac_flow
    entity: climate.living_room_ac
    anchor: ac_unit_living
    direction: down-right
    z_offset: 20

entities:
  - entity: light.kitchen
    type3d: light
    object_id: Kitchen_lamp
    light:
      lumens: 600
      decay: 1
      distance: 350
  - entity: binary_sensor.front_door
    type3d: door
    object_id: FrontDoor
    door:
      doortype: swing
      direction: inner
      side: left
      degrees: 90
```

---

## Credits

Original card by [adizanni](https://github.com/adizanni/floor3d-card).  
Room-aware smart home features (markers, room controls, animations, zoom entity, diagonal AC wind, sky/weather/moon system, backdrop blur, CSS height, particle weather effects) added by [anasmadrhar](https://github.com/anasmadrhar).

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/AndyHA)
