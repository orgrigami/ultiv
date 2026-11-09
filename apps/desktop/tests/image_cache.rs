//! The rune image cache decodes a real PNG off-thread and lands ready.

use std::sync::Arc;

#[test]
fn a_png_loads_decodes_and_reports_its_size() {
    let bytes = std::fs::read("/tmp/rune-study/board-shot.png").expect("the test PNG");
    let cache = Arc::new(rune::ImageCache::new(Arc::new(|| {})));
    let image = cache.load(bytes);
    let size = image.wait().expect("decode ok");
    assert!(size[0] > 0 && size[1] > 0, "a real size: {size:?}");
    assert!(image.is_ready());
    assert!(image.size().is_some());
}
