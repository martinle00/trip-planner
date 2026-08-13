---
"ctpapp": patch
---

Fix focus jumping to the close button on every keystroke inside a modal. The
shared `Modal` focus trap keyed its setup effect on `onClose`; callers that
rebuild that callback each render (Edit journey) re-ran the effect — and its
initial-focus call — on every render, so typing a city name moved focus to the
X after each letter. `onClose` is now read through a ref and the effect keys on
`open` alone.
