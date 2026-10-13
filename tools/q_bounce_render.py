"""Compose decoded image animation with the AE motion on a shared GIF timeline."""
import json, math, sys
from bisect import bisect_right
from collections import OrderedDict
from pathlib import Path
from PIL import Image, GifImagePlugin
LANCZOS = getattr(Image, 'Resampling', Image).LANCZOS
MEDIANCUT = getattr(Image, 'Quantize', Image).MEDIANCUT
MAX_TIMELINE_MS = 120000
MAX_TIMELINE_FRAMES = 2500
MAX_OUTPUT_PIXELS = 80000000

def gif_duration(value, fallback=100):
    try:
        value = float(value)
        if not math.isfinite(value) or value <= 0: value = fallback
    except (TypeError, ValueError): value = fallback
    return max(10, int(round(value / 10)) * 10)

def starts_of(durations):
    starts, total = [], 0
    for duration in durations:
        starts.append(total); total += duration
    return starts, total

def speed_starts(durations, target_ms):
    ticks = target_ms // 10
    original, total = starts_of(durations)
    if len(durations) > ticks:
        # GIF cannot represent sub-10ms frames. Sample the whole source cycle,
        # retaining its first and last frames instead of truncating its ending.
        return [0]+[max(1,min(ticks-1,round(t*ticks/total)))*10 for t in original[1:]]
    quotas = [d*ticks/total for d in durations]
    allocated = [max(1,int(q)) for q in quotas]
    while sum(allocated) > ticks:
        i = max((i for i,a in enumerate(allocated) if a > 1),key=lambda i:allocated[i]-quotas[i])
        allocated[i] -= 1
    while sum(allocated) < ticks:
        i = max(range(len(allocated)),key=lambda i:quotas[i]-allocated[i])
        allocated[i] += 1
    return starts_of([a*10 for a in allocated])[0]

def timeline(source_durations, motion_durations, mode='complete'):
    motion_starts, motion_total = starts_of(motion_durations)
    if len(source_durations) == 1:
        return [(0, i, d) for i, d in enumerate(motion_durations)], motion_total
    source_starts, source_total = starts_of(source_durations)
    if mode == 'speed':
        source_starts = speed_starts(source_durations,motion_total)
        source_total = motion_total
    total = motion_total if mode in ('truncate','speed') else source_total // math.gcd(source_total, motion_total) * motion_total
    if total > MAX_TIMELINE_MS:
        raise ValueError('原动画与弹性动画的完整循环超过 120 秒，请调整原 GIF 时长后重试')
    boundaries = {0, total}
    for starts, period in ((source_starts, source_total), (motion_starts, motion_total)):
        for offset in range(0, total, period):
            for start in starts:
                if offset + start >= total: break
                boundaries.add(offset + start)
                if len(boundaries) > MAX_TIMELINE_FRAMES + 1:
                    raise ValueError('完整循环超过 2500 帧，请简化原 GIF 或调整时长后重试')
    points = sorted(boundaries)
    return [(bisect_right(source_starts, t % source_total)-1,
             bisect_right(motion_starts, t % motion_total)-1,
             points[i+1]-t) for i, t in enumerate(points[:-1])], total

def visible_frame(im):
    rgba = im.convert('RGBA')
    alpha = rgba.getchannel('A')
    mask = alpha.point(lambda a: 255 if a > 25 else 0)
    rgba.putalpha(Image.composite(alpha, Image.new('L', rgba.size, 0), mask))
    return rgba, mask.getbbox()

def geometry(w, h, samples, offsets):
    ax, ay = w*.5, h*.98
    movement = [(o[0]*h, o[1]*h) for o in offsets]
    rectangles = [(dx-ax*s[0], dy-ay*s[1], dx+(w-ax)*s[0], dy+(h-ay)*s[1])
                  for s, (dx, dy) in zip(samples, movement)]
    left = math.ceil(-min(r[0] for r in rectangles))+3
    top = math.ceil(-min(r[1] for r in rectangles))+3
    size = (left+math.ceil(max(r[2] for r in rectangles))+3,
            top+math.ceil(max(r[3] for r in rectangles))+3)
    return ax, ay, movement, left, top, size

def render(source, destination, profile, mode='first'):
    if mode not in ('first','truncate','complete','speed'):
        raise ValueError('未知动图规则')
    if Path(source).stat().st_size > 12*1024*1024:
        raise ValueError('图片文件过大，请使用 12 MB 以内的图片')
    data = json.loads(Path(profile).read_text(encoding='utf-8-sig'))
    samples = data['samples']; motion_durations = data['durations_ms']
    if not 2 <= len(samples) <= 300 or len(samples) != len(motion_durations):
        raise ValueError('动画缩放配置无效')
    if any(len(s) < 2 or any(not math.isfinite(v) or not 0 < v <= 4 for v in s[:2]) for s in samples):
        raise ValueError('动画缩放范围无效')
    if any(not isinstance(d, (int, float)) or not math.isfinite(d) or d <= 0 for d in motion_durations):
        raise ValueError('动画时长配置无效')
    motion_durations = [gif_duration(d) for d in motion_durations]
    offsets = data.get('offsets_height', [[0,0] for _ in samples])
    if len(offsets) != len(samples) or any(len(o) != 2 or not all(math.isfinite(v) and abs(v) <= 10 for v in o) for o in offsets):
        raise ValueError('动画位移配置无效')
    with Image.open(source) as im:
        if im.format not in ('PNG','JPEG','WEBP','GIF','BMP','TIFF','ICO'):
            raise ValueError('暂不支持该图像格式，请使用 PNG、JPG、WebP、GIF 或 BMP')
        # TIFF pages and ICO sizes are not animations. APNG's optional poster is skipped.
        animated = mode != 'first' and im.format in ('GIF','WEBP','PNG') and getattr(im, 'is_animated', False)
        first = 1 if animated and im.info.get('default_image', False) else 0
        count = getattr(im, 'n_frames', 1)-first if animated else 1
        if im.width*im.height > 8000000:
            raise ValueError('图片尺寸过大，请缩小后重试')
        if count > 300 or animated and im.width*im.height*count > 64000000:
            raise ValueError('原动画帧数或总像素过多，请缩小或简化 GIF 后重试')
        bbox = None; source_durations = []
        for i in range(count):
            im.seek(first+i if animated else 0)
            rgba, current = visible_frame(im)
            if current is not None:
                if bbox is None: bbox = current
                else: bbox = (min(bbox[0],current[0]), min(bbox[1],current[1]),
                              max(bbox[2],current[2]), max(bbox[3],current[3]))
            source_durations.append(gif_duration(im.info.get('duration', 100)))
        if bbox is None:
            raise ValueError('图片没有 alpha 大于 25 的可见内容')
        schedule, total = timeline(source_durations, motion_durations, mode)
        bw, bh = bbox[2]-bbox[0], bbox[3]-bbox[1]
        ratio = min(1, (256 if count > 1 else 512)/max(bw,bh))
        if count > 1:
            ratio = min(ratio, math.sqrt(4000000/(bw*bh*count)))
        # Bound processing work as well as the decoded source cache.
        while True:
            w, h = max(1,round(bw*ratio)), max(1,round(bh*ratio))
            ax, ay, movement, left, top, size = geometry(w,h,samples,offsets)
            pixels = size[0]*size[1]*len(schedule)
            if pixels <= MAX_OUTPUT_PIXELS: break
            ratio *= math.sqrt(MAX_OUTPUT_PIXELS/pixels)*.95
            if max(w,h) <= 32:
                raise ValueError('完整动画生成量过大，请简化原 GIF 后重试')
        sources = []
        for i in range(count):
            im.seek(first+i if animated else 0)
            rgba, _ = visible_frame(im)
            rgba = rgba.crop(bbox)
            if rgba.size != (w,h): rgba = rgba.resize((w,h),LANCZOS)
            sources.append(rgba)
    cache = OrderedDict(); cache_pixels = 0; rendered_pairs = 0
    def composed(source_index, motion_index):
        nonlocal cache_pixels, rendered_pairs
        key = (source_index, motion_index)
        if key in cache:
            cache.move_to_end(key)
        else:
            sx, sy = samples[motion_index][:2]; dx, dy = movement[motion_index]
            nw, nh = max(1,round(w*sx)), max(1,round(h*sy))
            frame = Image.new('RGBA',size)
            scaled = sources[source_index].resize((nw,nh),LANCZOS)
            frame.alpha_composite(scaled,(round(left+dx-ax*nw/w),round(top+dy-ay*nh/h)))
            opaque = frame.convert('RGB').quantize(colors=255,method=MEDIANCUT)
            opaque.paste(255,mask=frame.getchannel('A').point(lambda a:255 if a <= 25 else 0))
            opaque.info['transparency'] = 255
            cache[key] = opaque
            rendered_pairs += 1
            cache_pixels += size[0]*size[1]
            while len(cache) > 1 and cache_pixels > 16000000:
                cache.popitem(last=False); cache_pixels -= size[0]*size[1]
        return cache[key]
    if count == 1:
        # Retain the existing static-image encoding and duplicate-frame behavior.
        frames = [composed(s,m) for s,m,d in schedule]
        frames[0].save(destination,save_all=True,append_images=frames[1:],
                       duration=[d for s,m,d in schedule],loop=0,
                       transparency=255,disposal=2,optimize=False)
    else:
        # The regular save_all writer buffers output frames. Stream independent,
        # fully composited frames instead; local palettes preserve each frame's colors.
        with open(destination,'wb') as output:
            initial = composed(schedule[0][0],schedule[0][1])
            header, _ = GifImagePlugin.getheader(initial,info={'transparency':255,'background':255})
            for chunk in header: output.write(chunk)
            # getheader() in older Pillow ignores loop; write the standard extension explicitly.
            output.write(b'\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00')
            for source_index, motion_index, duration in schedule:
                frame = composed(source_index,motion_index)
                for chunk in GifImagePlugin.getdata(frame,duration=duration,disposal=2,
                                                    transparency=255,include_color_table=True):
                    output.write(chunk)
                if output.tell() > 8*1024*1024:
                    break
            output.write(b';')
    if Path(destination).stat().st_size > 8*1024*1024:
        Path(destination).unlink(); raise ValueError('生成的 GIF 过大，请使用更小或更短的动画')
    return {'bbox':list(bbox),'anchor_original':[bbox[0]+bw*.5,bbox[1]+bh*.98],
            'canvas':list(size),'frame_count':len(schedule),'duration_ms':total,
            'source_frame_count':count,'source_cycle_ms':sum(source_durations) if count > 1 else 0,
            'motion_cycle_ms':sum(motion_durations),'rendered_pairs':rendered_pairs,'mode':mode,
            'source_frames_used':len(set(s for s,m,d in schedule))}

if __name__ == '__main__':
    try: print(json.dumps(render(*sys.argv[1:]),ensure_ascii=False))
    except Exception as e:
        print(str(e),file=sys.stderr);sys.exit(1)
