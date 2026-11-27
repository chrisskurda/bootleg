// The real inputs, through cpal. Whatever sample format the device gives is turned into f32.
use super::{Backend, Chunk, DeviceInfo, Running};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::Sender;

pub struct System;
struct Live(#[allow(dead_code)] cpal::Stream);
// cpal's Stream isn't Send on every platform; it is only ever dropped from the job thread that created it.
unsafe impl Send for Live {}
impl Running for Live {}

const RATES: [u32; 6] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];

impl Backend for System {
    fn name(&self) -> &'static str { "system" }
    fn devices(&self) -> Result<Vec<DeviceInfo>, String> {
        let host = cpal::default_host(); let def = host.default_input_device().and_then(|d| d.name().ok());
        let mut out = vec![];
        for d in host.input_devices().map_err(|e| e.to_string())? {
            let Ok(name) = d.name() else { continue };
            let Ok(cfg) = d.default_input_config() else { continue };
            let ranges: Vec<_> = d.supported_input_configs().map(|c| c.collect()).unwrap_or_default();
            let rates = RATES.iter().copied().filter(|r| ranges.iter().any(|c: &cpal::SupportedStreamConfigRange| c.min_sample_rate().0 <= *r && *r <= c.max_sample_rate().0)).collect();
            out.push(DeviceInfo { id: name.clone(), default: def.as_deref() == Some(&name), name, rates, channels: cfg.channels(), default_rate: cfg.sample_rate().0 });
        }
        Ok(out)
    }
    fn start(&self, id: &str, rate: u32, sink: Sender<Chunk>) -> Result<(Box<dyn Running>, u32, u16), String> {
        let host = cpal::default_host();
        let dev = host.input_devices().map_err(|e| e.to_string())?.find(|d| d.name().ok().as_deref() == Some(id)).ok_or_else(|| format!("no input called {id}"))?;
        let def = dev.default_input_config().map_err(|e| e.to_string())?;
        let want = if rate == 0 { def.sample_rate().0 } else { rate };
        let range = dev.supported_input_configs().map_err(|e| e.to_string())?.filter(|c| c.min_sample_rate().0 <= want && want <= c.max_sample_rate().0)
            .max_by_key(|c| (c.channels() >= 2, c.sample_format() == cpal::SampleFormat::F32, std::cmp::Reverse(c.channels()))).ok_or_else(|| format!("{id} can't record at {want} Hz"))?;
        let cfg = range.with_sample_rate(cpal::SampleRate(want)); let fmt = cfg.sample_format(); let ch = cfg.channels(); let conf: cpal::StreamConfig = cfg.into();
        let err_sink = sink.clone(); let on_err = move |e: cpal::StreamError| { let _ = err_sink.send(Chunk::Failed(e.to_string())); };
        macro_rules! build { ($t:ty, $conv:expr) => {{ let s = sink.clone(); dev.build_input_stream(&conf, move |d: &[$t], _: &cpal::InputCallbackInfo| { let _ = s.send(Chunk::Audio(d.iter().map($conv).collect())); }, on_err, None) }} }
        let stream = match fmt {
            cpal::SampleFormat::F32 => build!(f32, |&x| x),
            cpal::SampleFormat::I16 => build!(i16, |&x| x as f32 / 32768.0),
            cpal::SampleFormat::I32 => build!(i32, |&x| x as f32 / 2147483648.0),
            cpal::SampleFormat::U16 => build!(u16, |&x| (x as f32 - 32768.0) / 32768.0),
            f => return Err(format!("unsupported sample format {f:?}")),
        }.map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((Box::new(Live(stream)), want, ch))
    }
}
