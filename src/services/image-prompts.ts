/**
 * Technical Prompt Wrappers for AI Image Studio
 * Deterministic prompt formatting for text-to-image and image-to-image workflows.
 */

export interface PromptWrapperResult {
  readonly prompt: string
  readonly negativePrompt: string
}

export function buildAnimePrompt(userInput: string): PromptWrapperResult {
  const clean = userInput.trim()
  return {
    prompt: `Anime key visual, ${clean}. Makoto Shinkai and Kyoto Animation aesthetic, vibrant cel-shading with clean gradient shadows, dynamic atmospheric lighting, volumetric god rays, sharp consistent linework, detailed painted background, cinematic 16:9 composition, masterpiece illustration quality.`,
    negativePrompt: 'blurry linework, inconsistent character design, extra fingers, malformed hands, distorted face, muddy colors, oversaturated skin, jpeg artifacts, watermark, signature, text overlay, low resolution, flat lighting',
  }
}

export function buildLogoPrompt(brandName: string, concept: string): PromptWrapperResult {
  const cleanBrand = brandName.trim()
  const cleanConcept = concept.trim()
  return {
    prompt: `Minimalist vector logo for "${cleanBrand}", concept: ${cleanConcept}. Flat vector design, geometric golden-ratio construction, clean isolated white background, solid limited color palette, crisp sharp edges, professional brand identity, centered composition, scalable icon design, no photographic elements.`,
    negativePrompt: 'blurry text, misspelled lettering, distorted typography, 3D bevel artifacts, drop shadow, gradient mesh, noisy background, photographic elements, cluttered composition, low contrast, watermark',
  }
}

export function buildI2iPrompt(instruction: string): PromptWrapperResult {
  const clean = instruction.trim()
  return {
    prompt: `Image-to-image edit. Preserve the main subject identity, facial features, and body proportions exactly. Apply the following change: ${clean}. Match the new elements with the original lighting direction, color temperature, and shadow density. Maintain consistent perspective and scale. Photorealistic integration, no visible seams.`,
    negativePrompt: 'identity drift, face change, altered body shape, inconsistent lighting, mismatched shadows, floating objects, distorted anatomy, extra limbs, blurry edges, artifacts, watermark',
  }
}

export function buildBgChangePrompt(newBackground: string): PromptWrapperResult {
  const clean = newBackground.trim()
  return {
    prompt: `Background replacement. Lock and preserve the foreground subject with pixel-accurate identity, pose, and clothing. Replace the background with: ${clean}. Match ambient lighting, rim light, and color temperature to the new environment. Cast realistic contact shadows and floor reflections. Seamless edge blending, no halos.`,
    negativePrompt: 'subject distortion, identity change, halo edges, mismatched lighting, floating subject, missing contact shadow, wrong perspective, color spill, artifacts, blur',
  }
}

export function buildRestorePrompt(): PromptWrapperResult {
  return {
    prompt: 'Image restoration. Strict identity preservation. De-blur and de-noise while reconstructing micro-textures and fine details. Enhance edge definition and local contrast. Remove compression artifacts, banding, and chromatic aberration. Restore realistic studio clarity without over-smoothing or plastic skin. Preserve natural grain structure where appropriate.',
    negativePrompt: 'over-smoothed skin, plastic texture, identity drift, changed facial features, halos, sharpening artifacts, color shift, added elements, loss of detail, watermark',
  }
}

export function buildCosplayPrompt(outfitDescription: string): PromptWrapperResult {
  const clean = outfitDescription.trim()
  return {
    prompt: `Wardrobe replacement. Keep face, hairstyle, head shape, and body proportions 100% identical. Replace clothing with: ${clean}. Render fabric texture, folds, seams, and material response realistically. Conform the garment to the body silhouette. Match lighting and shadow on the new fabric to the original scene.`,
    negativePrompt: 'face change, hairstyle change, body shape change, deformed hands, floating fabric, inconsistent folds, mismatched lighting, clipping, extra accessories, artifacts',
  }
}

export function buildRemixPrompt(styleGuidance: string): PromptWrapperResult {
  const clean = styleGuidance.trim()
  return {
    prompt: `Concept blend. Extract the main subject from Image 1 (identity, pose, composition) and apply the color palette, art style, and rendering treatment of Image 2: ${clean}. Preserve subject identity and silhouette. Recolor and restyle consistently across all elements. Unified lighting and texture language.`,
    negativePrompt: 'identity loss, style bleed into face, inconsistent palette, muddy colors, mixed lighting, distorted anatomy, artifacts, watermark, text',
  }
}
