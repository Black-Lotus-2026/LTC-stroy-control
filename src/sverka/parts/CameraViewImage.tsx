import { useEffect, useState } from 'react'
import type { ImgHTMLAttributes, Ref } from 'react'
import { viewAsset } from '../api'

/** Authenticated pictures enter the DOM only as local Blob URLs. */
export function CameraViewImage({ url, imageRef, ...props }: { url: string; imageRef?: Ref<HTMLImageElement> } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const protectedAsset = url.includes('/view/assets/') || url.includes('/media/')
  const [source, setSource] = useState({ url: '', blob: '' })
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!protectedAsset) return
    const controller = new AbortController()
    let blobUrl = ''
    setSource({ url, blob: '' }); setError(false)
    viewAsset(url, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      blobUrl = URL.createObjectURL(blob)
      setSource({ url, blob: blobUrl })
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { controller.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [url, protectedAsset])
  if (!protectedAsset) return <img {...props} ref={imageRef} src={url} />
  if (source.url !== url || !source.blob) return props['aria-hidden'] ? null : <small role="status">{error ? 'Изображение недоступно в текущем назначении или временно отсутствует' : 'Загружаем изображение…'}</small>
  return <img {...props} ref={imageRef} src={source.blob} />
}
