import type { Point } from './safetyApi'

export function polygonProblem(points: Point[]): string {
  if (points.length < 3) return 'Нужно не менее 3 точек.'
  if (points.length > 32) return 'Допускается не более 32 точек.'
  if (points.some(p => p.some(v => !Number.isFinite(v) || v < 0 || v > 1))) return 'Координаты должны быть от 0 до 1.'
  if (new Set(points.map(p => p.join(','))).size !== points.length) return 'Точки не должны повторяться.'
  const cross = (a: Point, b: Point, c: Point) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
  const area = Math.abs(points.reduce((sum,p,i) => { const q=points[(i+1)%points.length]; return sum+p[0]*q[1]-q[0]*p[1] },0))/2
  if (area < .0001) return 'Площадь зоны слишком мала.'
  for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
    if (j === i+1 || (j+1)%points.length === i) continue
    const a=points[i], b=points[(i+1)%points.length], c=points[j], d=points[(j+1)%points.length]
    if (Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0])) <= Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0])) && Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1])) <= Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1])) && cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0) return 'Контур пересекает себя. Отмените точку или измените координаты.'
  }
  return ''
}
