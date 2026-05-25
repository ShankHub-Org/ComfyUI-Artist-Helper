# ComfyUI Artist Helper

A ComfyUI custom node for artist wildcards, favorites/blacklist management, and prompt autocomplete - built for Anima.

## Features

- @random artist wildcard
- @fav favorite wildcard
- Artist autocomplete popup
- Favorites system
- Blacklist system
- Filename-safe artist output
- Prompt helper node

## Install

Clone into:

ComfyUI/custom_nodes/

```bash
git clone https://github.com/ShankHub-Org/ComfyUI-Artist-Helper.git
```

Then restart ComfyUI.

## Node

Adds:

- Artist Helper

## Note

This helper was originally designed for Anima, where artist tags are commonly written like:

```text
@artist_name
```
### Example

<p align="center">
  <img src="examples/Artist%20Helper.jpg" width="700"/>
</p>

For many other checkpoints, you may get better results by converting tags into more natural language styles such as:

```text
artist name style
(artist name style)
in the style of artist name
artist name \(style\)
```

Different checkpoints interpret artist/style prompts differently, so results may vary depending on model training.

## Example Workflow

Drag the image below into ComfyUI to load the workflow:

![Example Workflow](examples/example_workflow.png)

## Credits

Artist tag data sourced from:
- https://thetacursed.github.io/Anima-Style-Explorer/index.html
- https://tagexplorer.github.io/#/artists

Autocomplete UX inspiration:
- https://github.com/newtextdoc1111/ComfyUI-Autocomplete-Plus
