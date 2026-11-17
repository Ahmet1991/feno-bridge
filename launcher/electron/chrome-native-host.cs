using System;
using System.IO;
using System.Net;
using System.Text;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ChromeNativeHost {
    internal const string Origin = "chrome-extension://mcimkhafgpcecjdjjiljhljdkaggapfa/";
    internal const string HostName = "com.feno.bridge.pc2";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    static readonly Stream Input = Console.OpenStandardInput(), Output = Console.OpenStandardOutput();
    static readonly BlockingCollection<string> Inbox = new BlockingCollection<string>(8);
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    const int MaxInput = 32 * 1024 * 1024;
    static volatile bool Closed;
    static byte[] ReadExact(int length) {
        byte[] buffer = new byte[length]; int at=0;
        while(at<length) { int n=Input.Read(buffer,at,length-at); if(n==0) throw new EndOfStreamException(); at+=n; }
        return buffer;
    }
    static void ReadLoop() {
        try {
            while(!Closed) {
                int length=BitConverter.ToInt32(ReadExact(4),0);
                if(length<1||length>MaxInput)throw new InvalidDataException();
                if(!Inbox.TryAdd(Utf8.GetString(ReadExact(length)),1000))break;
            }
        }catch{} finally {Closed=true;Inbox.CompleteAdding();}
    }
    static void Send(object message) {
        byte[] data=Utf8.GetBytes(Json.Serialize(message));
        if(data.Length>1024*1024)throw new InvalidDataException();
        byte[] len=BitConverter.GetBytes(data.Length);
        Output.Write(len,0,len.Length);Output.Write(data,0,data.Length);Output.Flush();
    }
    static Dictionary<string, object> Parse(string text) {return Json.Deserialize<Dictionary<string,object>>(text);}
    static string Field(Dictionary<string,object> data,string name) {
        object val;return data!=null&&data.TryGetValue(name,out val)?val as string:null;
    }
    static string DescriptorPath() {
#if FENO_CHROME_TEST
        string fixture=Environment.GetEnvironmentVariable("FENO_CHROME_TEST_DESCRIPTOR");
        if(String.IsNullOrEmpty(fixture)||!Path.IsPathRooted(fixture))throw new InvalidDataException();
        return fixture;
#else
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Feno Bridge Chrome PC2","chrome-native-descriptor.json");
#endif
    }
    static Dictionary<string,object> Request(string endpoint, object body) {
        string descriptor=DescriptorPath();
        if(new FileInfo(descriptor).Length>4096)throw new InvalidDataException();
        var info=Parse(File.ReadAllText(descriptor,Utf8));
        int port=Convert.ToInt32(info["port"]); string token=Field(info,"token");
        if(port<1||port>65535||token==null||!System.Text.RegularExpressions.Regex.IsMatch(token,"^[a-f0-9]{64}$"))throw new InvalidDataException();
        var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+endpoint);
        req.Proxy=null;req.AllowAutoRedirect=false;req.Method="POST";req.ContentType="application/json";req.Timeout=5000;req.ReadWriteTimeout=5000;
        req.Headers["Authorization"]="Bearer "+token;
        byte[] payload=Utf8.GetBytes(Json.Serialize(body));req.ContentLength=payload.Length;
        using(var stream=req.GetRequestStream())stream.Write(payload,0,payload.Length);
        using(var response=req.GetResponse())
        using(var stream=response.GetResponseStream())
        using(var reader=new StreamReader(stream,Utf8)) {
            char[] chunk=new char[4096];var result=new StringBuilder();int n;
            while((n=reader.Read(chunk,0,chunk.Length))>0){if(result.Length+n>1024*1024)throw new InvalidDataException();result.Append(chunk,0,n);}
            return Parse(result.ToString());
        }
    }
    static void WriteManifest() {
        string exe=System.Reflection.Assembly.GetExecutingAssembly().Location;
        string manifest=Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(exe))),"chrome-native-host.json");
        File.WriteAllText(manifest,Json.Serialize(new {name=HostName,description="Feno Bridge PC2 native host",path=exe,type="stdio",allowed_origins=new[]{Origin}}),Utf8);
    }
    static int Main(string[] args) {
        // Registration is invoked only by the installer. Native invocations must supply our exact extension origin.
        if(args.Length==1&&args[0]=="--manifest"){try{WriteManifest();return 0;}catch{return 1;}}
        if(args.Length<1||args[0]!=Origin)return 1;
        string session=Guid.NewGuid().ToString(), raw;
        var reader=new Thread(ReadLoop){IsBackground=true};reader.Start();
        try {
            if(!Inbox.TryTake(out raw,10000))return 1;
            var hello=Parse(raw);string version=Field(hello,"version");
            if(Field(hello,"type")!="hello"||version==null||!System.Text.RegularExpressions.Regex.IsMatch(version,"^\\d+\\.\\d+\\.\\d+$"))return 1;
            while(!Closed){
                Dictionary<string,object> command;
                try{command=Request("/poll",new{session,version});}catch{Thread.Sleep(2000);continue;}
                string type=Field(command,"type");
                if(type=="reload"){Send(command);return 0;}
                if(type!="command"){Thread.Sleep(300);continue;}
                string id=Field(command,"id");if(id==null)continue;
                Send(command);
                var deadline=DateTime.UtcNow.AddSeconds(65);
                while(!Inbox.TryTake(out raw,500)){
                    if(Closed||DateTime.UtcNow>=deadline)return 1;
                    try{
                        var heartbeat=Request("/heartbeat",new{session,id});
                        if(Field(heartbeat,"type")!="continue")return 1;
                    }catch{return 1;}
                }
                var result=Parse(raw);
                if(Field(result,"type")!="result"||Field(result,"id")!=id)return 1;
                result["session"]=session;
                try{Request("/result",result);}catch{/* A lost broker is never retried with a previous command. */}
            }
        }catch{return 1;}
        finally{try{Request("/disconnect",new{session});}catch{}}
        return 0;
    }
}
