const immersiveUi = [
  '.immersive-translate-target-wrapper', '.immersive-translate-popup-wrapper',
  '.imt-notranslate:not([data-github-zh-owned])', '[id^="immersive-translate-"]',
  '[class^="immersive-translate-target-"]',
].join(',');

// Keep the first active translator for an individual README/About block.
// The imt class is understood by Immersive without suppressing GitHub's walker.
const githubCandidates = new WeakSet();
function canTranslateGithubBlock(element) {
  githubCandidates.add(element);
  return element.hasAttribute('data-github-zh-owned')
    || (!element.closest(immersiveUi) && !element.querySelector(immersiveUi));
}

function claimGithubBlock(element) {
  if (element.hasAttribute('data-github-zh-owned')) return true;
  if (!canTranslateGithubBlock(element)) return false;
  element.classList.add('imt-notranslate');
  element.setAttribute('data-github-zh-owned', '');
  return true;
}

function releaseGithubBlocks() {
  for (const element of document.querySelectorAll('[data-github-zh-owned]')) {
    element.classList.remove('imt-notranslate');
    element.removeAttribute('data-github-zh-owned');
  }
}
