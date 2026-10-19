// Test-only RPC shell around the unmodified current core's StartedService.
// It listens only on an ephemeral loopback port and exposes no OS proxy controls.
// Build from the sibling core module; never use this executable as a client daemon.
package main

import (
	"context"
	"flag"
	"net"
	"os"
	"strings"

	"github.com/sagernet/sing-box/daemon"
	"github.com/sagernet/sing-box/include"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type testPlatform struct{}

func (testPlatform) WriteDebugMessage(string)        {}
func (testPlatform) ConnectSSHAgent() (int32, error) { return -1, os.ErrInvalid }

func main() {
	args := flag.NewFlagSet("fixture", flag.ExitOnError)
	directory := args.String("working-directory", "", "isolated directory")
	address := args.String("listen", "", "loopback only")
	_ = args.Parse(os.Args[2:])
	if !strings.HasPrefix(*address, "127.0.0.1:") || *directory == "" {
		panic("isolated loopback fixture only")
	}
	if err := os.Chdir(*directory); err != nil {
		panic(err)
	}
	svc := daemon.NewStartedService(daemon.ServiceOptions{Context: include.Context(context.Background()), Handler: testPlatform{}, LogMaxLines: 16})
	server := grpc.NewServer(daemon.MessageSizeServerOptions()...)
	daemon.RegisterStartedServiceServer(server, svc)
	// StringValue uses the same field-1 wire representation as config_content and
	// version. Only these two desktop methods exist in this test RPC shell.
	server.RegisterService(&grpc.ServiceDesc{ServiceName: "desktop.DesktopService", HandlerType: (*interface{})(nil), Methods: []grpc.MethodDesc{
		{MethodName: "GetDaemonInfo", Handler: func(_ interface{}, _ context.Context, decode func(interface{}) error, _ grpc.UnaryServerInterceptor) (interface{}, error) {
			if err := decode(&emptypb.Empty{}); err != nil {
				return nil, err
			}
			return wrapperspb.String("current-source-test-fixture"), nil
		}},
		{MethodName: "StartService", Handler: func(_ interface{}, ctx context.Context, decode func(interface{}) error, _ grpc.UnaryServerInterceptor) (interface{}, error) {
			request := &wrapperspb.StringValue{}
			if err := decode(request); err != nil {
				return nil, err
			}
			err := svc.StartOrReloadService(ctx, request.Value, nil)
			return &emptypb.Empty{}, err
		}},
	}}, svc)
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		panic(err)
	}
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
